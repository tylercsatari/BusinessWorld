/**
 * Library UI — Ideas, To-Do list, Calendar, Projects, Invoices.
 * All data stored in R2 JSON files via /api/data/* routes.
 * Scripts are now embedded in ideas (idea.script field).
 */
const LibraryUI = (() => {
    let container = null;
    let invoiceItems = [];     // [{id, company, amount, currency, expectedDate, notes, paid}]
    let invoicesLoaded = false;
    let invoicesBusy = false;
    const CAD_RATES = { CAD: 1, USD: 1.36, EUR: 1.50, GBP: 1.73 };
    let currentPage = 'list';
    let activeTab = 'notes';
    let selectedNote = null;
    let noteSaveTimer = null;
    let noteDirty = false;
    let todoItems = [];  // [{id, text, done, category}]
    let todoCategory = 'daily'; // current add category toggle
    let calendarItems = []; // [{id, text, date, time, done}]
    let calendarLoaded = false;
    let calendarBusy = false;
    let calendarViewMode = 'week'; // 'week' | 'month'
    let calendarSelectedDate = null; // Date object
    let selectedVideo = null;
    let videoSaveTimer = null;
    let videoDirty = false;

    const escHtml = HtmlUtils.escHtml;
    const escAttr = HtmlUtils.escAttr;

    // Config no longer needed for page IDs — data comes from /api/data/* routes
    async function loadConfig() { /* no-op — kept for call-site compat */ }

    function formatDate(dateStr) {
        const d = new Date(dateStr);
        const now = new Date();
        const diff = Math.floor((now - d) / 86400000);
        if (diff === 0) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        if (diff === 1) return 'Yesterday';
        if (diff < 7) return d.toLocaleDateString('en-US', { weekday: 'long' });
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function setSaveStatus(status) {
        const el = document.getElementById('library-save-status');
        if (!el) return;
        el.textContent = status;
        el.className = 'library-save-status' + (status === 'Saved' ? ' saved' : status === 'Saving...' ? ' saving' : '');
    }

    // --- Navigation ---
    function showListPage() {
        currentPage = 'list';
        const panel = container.querySelector('.library-panel');
        if (!panel) return;
        panel.classList.remove('show-editor');
        panel.classList.add('show-list');
        if (activeTab === 'notes') renderNotesList();
        else if (activeTab === 'calendar') renderCalendarList();
        else if (activeTab === 'projects') renderProjectsList();
    }

    function showEditorPage() {
        currentPage = 'editor';
        const panel = container.querySelector('.library-panel');
        if (!panel) return;
        panel.classList.remove('show-list');
        panel.classList.add('show-editor');
    }

    // --- Main render ---
    function render(bodyEl) {
        container = bodyEl;
        container.innerHTML = `
            <div class="library-panel show-list">
                <div class="library-page library-list-page" id="library-list-page">
                    <div class="library-tabs">
                        <button class="library-tab active" data-tab="notes">Ideas</button>
                        <button class="library-tab" data-tab="todo">To-Do</button>
                        <button class="library-tab" data-tab="calendar">Calendar</button>
                        <button class="library-tab" data-tab="projects">Projects</button>
                        <button class="library-tab" data-tab="invoices">Invoices</button>
                    </div>
                    <div class="library-list-header" id="library-list-header">
                        <h2 class="library-list-heading" id="library-list-heading">Ideas</h2>
                        <button class="library-new-btn" id="library-new-btn" title="New">+</button>
                    </div>
                    <div class="library-notes-list" id="library-notes-list">${Array(4).fill('<div class="library-skeleton-item"><div class="library-skeleton-icon"></div><div class="library-skeleton-text"><div class="library-skeleton-line"></div><div class="library-skeleton-line short"></div></div></div>').join('')}</div>
                    <div class="library-todo-container" id="library-todo-container" style="display:none;"></div>
                    <div class="library-calendar-container" id="library-calendar-container" style="display:none;"></div>
                    <div class="library-projects-container" id="library-projects-container" style="display:none;"></div>
                    <div class="library-invoices-container" id="library-invoices-container" style="display:none;"></div>
                </div>
                <div class="library-page library-editor-page" id="library-editor-page">
                    <div class="library-editor" id="library-editor">
                        <div class="library-editor-empty"><div class="library-editor-empty-icon">📝</div><div>Select a script or create a new one</div></div>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('library-new-btn').addEventListener('click', () => {
            if (activeTab === 'notes') handleNewNote();
            // todo/calendar use inline input, no + button action needed — but we'll focus the input
            else if (activeTab === 'todo') focusTodoInput();
            else if (activeTab === 'calendar') focusCalendarInput();
        });
        container.querySelectorAll('.library-tab').forEach(tab => {
            tab.addEventListener('click', () => switchTab(tab.dataset.tab));
        });
    }

    function switchTab(tab) {
        activeTab = tab;
        container.querySelectorAll('.library-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        const heading = document.getElementById('library-list-heading');
        const notesList = document.getElementById('library-notes-list');
        const todoContainer = document.getElementById('library-todo-container');
        const calendarContainer = document.getElementById('library-calendar-container');
        const projectsContainer = document.getElementById('library-projects-container');
        const invoicesContainer = document.getElementById('library-invoices-container');

        if (notesList) notesList.style.display = 'none';
        if (todoContainer) todoContainer.style.display = 'none';
        if (calendarContainer) calendarContainer.style.display = 'none';
        if (projectsContainer) projectsContainer.style.display = 'none';
        if (invoicesContainer) invoicesContainer.style.display = 'none';

        const newBtn = document.getElementById('library-new-btn');

        if (tab === 'notes') {
            if (heading) heading.textContent = 'Ideas';
            if (notesList) notesList.style.display = '';
            if (newBtn) newBtn.style.display = '';
            renderNotesList();
        } else if (tab === 'todo') {
            if (heading) heading.textContent = 'To-Do';
            if (todoContainer) todoContainer.style.display = '';
            if (newBtn) newBtn.style.display = '';
            renderTodoList();
            if (todoLoaded) backgroundRefreshTodo();
        } else if (tab === 'calendar') {
            if (heading) heading.textContent = 'Calendar';
            if (calendarContainer) calendarContainer.style.display = '';
            if (newBtn) newBtn.style.display = '';
            renderCalendarList();
            if (calendarLoaded) backgroundRefreshCalendar();
        } else if (tab === 'projects') {
            if (heading) heading.textContent = 'Projects';
            if (projectsContainer) projectsContainer.style.display = '';
            if (newBtn) newBtn.style.display = 'none';
            renderProjectsList();
        } else if (tab === 'invoices') {
            if (heading) heading.textContent = 'Invoices';
            if (invoicesContainer) invoicesContainer.style.display = '';
            if (newBtn) newBtn.style.display = 'none';
            renderInvoicesList();
            if (invoicesLoaded) backgroundRefreshInvoices();
        }
    }

    // =====================
    // --- TO-DO LIST ---
    // =====================
    let todoLoaded = false;

    async function fetchTodoItems() {
        const res = await fetch('/api/data/todos');
        if (!res.ok) return [];
        return await res.json();
    }

    let todoBusy = false; // true while an add/delete/toggle API call is in progress

    function renderTodoList() {
        const el = document.getElementById('library-todo-container');
        if (!el) return;

        if (!todoLoaded) {
            el.innerHTML = '<div class="library-empty">Loading to-do list...</div>';
            fetchTodoItems().then(items => {
                todoItems = items;
                todoLoaded = true;
                renderTodoList();
                updateTodoBadge();
            }).catch(() => {
                el.innerHTML = '<div class="library-empty">Could not load to-do list.</div>';
            });
            return;
        }

        renderTodoContent(el);
    }

    // Background refresh — only called when switching to the tab, not on every render
    function backgroundRefreshTodo() {
        if (todoBusy) return; // don't overwrite optimistic updates mid-operation
        fetchTodoItems().then(freshItems => {
            if (todoBusy) return; // check again after await
            if (freshItems && freshItems.length >= 0) {
                todoItems = freshItems;
                updateTodoBadge();
                const currentEl = document.getElementById('library-todo-container');
                if (currentEl) renderTodoContent(currentEl);
            }
        }).catch(() => {});
    }

    function renderTodoContent(el) {
        if (!el) return;

        const dailyItems = todoItems.filter(i => i.category === 'daily');
        const weeklyItems = todoItems.filter(i => i.category === 'weekly');

        function renderSection(label, items) {
            if (items.length === 0) return '';
            return `
                <div class="library-todo-section-header">${escHtml(label)}</div>
                ${items.map(item => {
                    const idx = todoItems.indexOf(item);
                    return `
                    <div class="library-todo-item ${item.done ? 'done' : ''}" data-idx="${idx}">
                        <button class="library-todo-check" data-idx="${idx}">${item.done ? '&#10003;' : ''}</button>
                        <span class="library-todo-text">${escHtml(item.text)}</span>
                        <button class="library-todo-delete" data-idx="${idx}">&times;</button>
                    </div>`;
                }).join('')}
            `;
        }

        el.innerHTML = `
            <div class="library-todo-input-row">
                <input type="text" class="library-todo-input" id="library-todo-input" placeholder="Add a new task..." />
                <button class="library-todo-category-btn" id="library-todo-category-btn" title="Toggle Today/General">${todoCategory === 'daily' ? 'T' : 'G'}</button>
                <button class="library-todo-add-btn" id="library-todo-add-btn">Add</button>
            </div>
            ${todoItems.length === 0 ? '<div class="library-todo-empty">No tasks yet. Type above to add one.</div>' : ''}
            <div class="library-todo-items" id="library-todo-items">
                ${renderSection('Today', dailyItems)}
                ${renderSection('General', weeklyItems)}
            </div>
        `;

        const input = document.getElementById('library-todo-input');
        const addBtn = document.getElementById('library-todo-add-btn');
        const catBtn = document.getElementById('library-todo-category-btn');

        catBtn.addEventListener('click', () => {
            todoCategory = todoCategory === 'daily' ? 'weekly' : 'daily';
            catBtn.textContent = todoCategory === 'daily' ? 'T' : 'G';
            catBtn.classList.toggle('general', todoCategory === 'weekly');
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && input.value.trim()) {
                addTodoItem(input.value.trim());
                input.value = '';
            }
        });
        addBtn.addEventListener('click', () => {
            if (input.value.trim()) {
                addTodoItem(input.value.trim());
                input.value = '';
                input.focus();
            }
        });

        el.querySelectorAll('.library-todo-check').forEach(btn => {
            btn.addEventListener('click', () => toggleTodoItem(parseInt(btn.dataset.idx)));
        });
        el.querySelectorAll('.library-todo-delete').forEach(btn => {
            btn.addEventListener('click', () => deleteTodoItem(parseInt(btn.dataset.idx)));
        });
    }

    function focusTodoInput() {
        const input = document.getElementById('library-todo-input');
        if (input) input.focus();
    }

    async function addTodoItem(text) {
        todoBusy = true;
        const tempItem = { id: null, text, done: false, category: todoCategory };
        todoItems.unshift(tempItem);
        renderTodoList();
        updateTodoBadge();

        try {
            const res = await fetch('/api/data/todos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, done: false, category: todoCategory })
            });
            if (!res.ok) throw new Error('Failed');
            const created = await res.json();
            Object.assign(tempItem, created);
        } catch (e) {
            console.warn('Library: add todo failed', e);
            todoItems = todoItems.filter(i => i !== tempItem);
            renderTodoList();
            updateTodoBadge();
            alert('Failed to add task. Check connection.');
        } finally {
            todoBusy = false;
        }
    }

    async function toggleTodoItem(idx) {
        if (idx < 0 || idx >= todoItems.length) return;
        todoBusy = true;
        const item = todoItems[idx];
        item.done = !item.done;
        renderTodoList();
        updateTodoBadge();

        if (item.id) {
            try {
                await fetch(`/api/data/todos/${item.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ done: item.done })
                });
            } catch (e) {
                console.warn('Library: toggle todo failed', e);
                item.done = !item.done;
                renderTodoList();
                updateTodoBadge();
            }
        }
        todoBusy = false;
    }

    async function deleteTodoItem(idx) {
        if (idx < 0 || idx >= todoItems.length) return;
        if (!confirm('Delete this task?')) return;
        todoBusy = true;
        const item = todoItems[idx];
        todoItems.splice(idx, 1);
        renderTodoList();
        updateTodoBadge();

        if (item.id) {
            try {
                const res = await fetch(`/api/data/todos/${item.id}`, { method: 'DELETE' });
                if (!res.ok) throw new Error('Delete failed');
            } catch (e) {
                console.warn('Library: delete todo failed', e);
                todoItems.splice(idx, 0, item);
                renderTodoList();
                updateTodoBadge();
                alert('Failed to delete task. It has been restored.');
            }
        }
        todoBusy = false;
    }

    // =====================
    // --- CALENDAR ---
    // =====================

    async function fetchCalendarEvents() {
        const res = await fetch('/api/data/calendar');
        if (!res.ok) return [];
        return await res.json();
    }

    function renderCalendarList() {
        const el = document.getElementById('library-calendar-container');
        if (!el) return;
        if (!calendarLoaded) {
            el.innerHTML = '<div class="library-empty">Loading calendar...</div>';
            fetchCalendarEvents().then(items => {
                calendarItems = items;
                calendarLoaded = true;
                renderCalendarList();
                updateCalendarBadge();
            }).catch(() => {
                el.innerHTML = '<div class="library-empty">Could not load calendar.</div>';
            });
            return;
        }
        renderCalendarContent(el);
    }

    function backgroundRefreshCalendar() {
        if (calendarBusy) return;
        fetchCalendarEvents().then(fresh => {
            if (calendarBusy) return;
            if (fresh && fresh.length >= 0) {
                calendarItems = fresh;
                updateCalendarBadge();
                const el = document.getElementById('library-calendar-container');
                if (el) renderCalendarContent(el);
            }
        }).catch(() => {});
    }

    function todayStr() {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    // --- Calendar helpers ---
    function startOfWeek(date) {
        const d = new Date(date);
        const day = d.getDay();
        const diff = (day === 0 ? -6 : 1) - day; // Monday = start
        d.setDate(d.getDate() + diff);
        d.setHours(0, 0, 0, 0);
        return d;
    }

    function formatDateKey(date) {
        return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
    }

    function isSameDay(d1, d2) {
        return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
    }

    function getEventsForDate(dateKey) {
        return calendarItems.filter(e => e.date === dateKey);
    }

    function generateTimeOptions() {
        const opts = [];
        for (let h = 6; h < 24; h++) {
            for (let m = 0; m < 60; m += 15) {
                const hh = String(h).padStart(2, '0');
                const mm = String(m).padStart(2, '0');
                const hour12 = h % 12 || 12;
                const ampm = h < 12 ? 'AM' : 'PM';
                opts.push({ value: `${hh}:${mm}`, label: `${hour12}:${mm} ${ampm}` });
            }
        }
        return opts;
    }

    function getDayLabel(date) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        if (isSameDay(date, today)) return 'Today';
        if (isSameDay(date, tomorrow)) return 'Tomorrow';
        return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }

    function formatTime12(timeStr) {
        if (!timeStr) return '';
        const [hh, mm] = timeStr.split(':');
        const h = parseInt(hh);
        const hour12 = h % 12 || 12;
        const ampm = h < 12 ? 'AM' : 'PM';
        return `${hour12}:${mm} ${ampm}`;
    }

    function formatCalDate(dateStr) {
        if (!dateStr) return '';
        const [y, m, d] = dateStr.split('-');
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return months[parseInt(m) - 1] + ' ' + parseInt(d);
    }

    function renderCalendarContent(el) {
        if (!el) return;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Default selected date to today
        if (!calendarSelectedDate) calendarSelectedDate = new Date(today);

        const selectedKey = formatDateKey(calendarSelectedDate);
        const todayKey = formatDateKey(today);
        const weekMonday = startOfWeek(calendarViewMode === 'week' ? calendarSelectedDate : calendarSelectedDate);

        // Build days with event indicators
        function hasEvents(dateKey) {
            return calendarItems.some(e => e.date === dateKey);
        }

        let navHtml = '';
        if (calendarViewMode === 'week') {
            // Week strip
            const days = [];
            const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
            for (let i = 0; i < 7; i++) {
                const d = new Date(weekMonday);
                d.setDate(weekMonday.getDate() + i);
                const key = formatDateKey(d);
                const isToday = key === todayKey;
                const isSelected = key === selectedKey;
                const dot = hasEvents(key) ? '<div class="library-cal-dot"></div>' : '';
                days.push(`
                    <div class="library-cal-day-card ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}" data-date="${key}">
                        <div class="library-cal-day-name">${dayNames[i]}</div>
                        <div class="library-cal-day-num">${d.getDate()}</div>
                        ${dot}
                    </div>`);
            }
            // Week navigation
            const prevWeek = new Date(weekMonday);
            prevWeek.setDate(prevWeek.getDate() - 7);
            const nextWeek = new Date(weekMonday);
            nextWeek.setDate(nextWeek.getDate() + 7);
            navHtml = `
                <div class="library-cal-nav">
                    <button class="library-cal-nav-btn" id="library-cal-prev" title="Previous week">&lsaquo;</button>
                    <div class="library-cal-strip">${days.join('')}</div>
                    <button class="library-cal-nav-btn" id="library-cal-next" title="Next week">&rsaquo;</button>
                </div>
                <div class="library-cal-toggle-row">
                    <button class="library-cal-toggle" id="library-cal-toggle-mode">Month</button>
                </div>`;
        } else {
            // Month grid — 4 weeks starting from selected week's Monday
            const gridMonday = startOfWeek(calendarSelectedDate);
            const monthName = calendarSelectedDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
            let cells = '';
            const dayHeaders = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
            cells += dayHeaders.map(d => `<div class="library-cal-month-header-cell">${d}</div>`).join('');
            for (let i = 0; i < 28; i++) {
                const d = new Date(gridMonday);
                d.setDate(gridMonday.getDate() + i);
                const key = formatDateKey(d);
                const isToday = key === todayKey;
                const isSelected = key === selectedKey;
                const dot = hasEvents(key) ? '<div class="library-cal-dot"></div>' : '';
                cells += `
                    <div class="library-cal-month-cell ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}" data-date="${key}">
                        <span>${d.getDate()}</span>
                        ${dot}
                    </div>`;
            }
            navHtml = `
                <div class="library-cal-month-nav">
                    <button class="library-cal-nav-btn" id="library-cal-prev" title="Previous 4 weeks">&lsaquo;</button>
                    <span class="library-cal-month-label">${monthName}</span>
                    <button class="library-cal-nav-btn" id="library-cal-next" title="Next 4 weeks">&rsaquo;</button>
                </div>
                <div class="library-cal-month-grid">${cells}</div>
                <div class="library-cal-toggle-row">
                    <button class="library-cal-toggle" id="library-cal-toggle-mode">Week</button>
                </div>`;
        }

        // Quick add bar — time select with 15-min increments
        const timeOpts = generateTimeOptions();
        const now = new Date();
        const nowH = String(now.getHours()).padStart(2, '0');
        const nowM = String(Math.ceil(now.getMinutes() / 15) * 15).padStart(2, '0');
        const defaultTime = nowM === '60' ? `${String(parseInt(nowH) + 1).padStart(2, '0')}:00` : `${nowH}:${nowM}`;

        const quickAddHtml = `
            <div class="library-cal-quick-add">
                <select class="library-cal-time-select" id="library-cal-time-select">
                    ${timeOpts.map(o => `<option value="${o.value}" ${o.value === defaultTime ? 'selected' : ''}>${o.label}</option>`).join('')}
                </select>
                <input type="text" class="library-cal-title-input" id="library-cal-title-input" placeholder="Event title..." />
                <button class="library-cal-add-btn" id="library-cal-add-btn">+ Add</button>
            </div>`;

        // Day events panel
        const dayEvents = getEventsForDate(selectedKey).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
        const dayLabel = getDayLabel(calendarSelectedDate);
        const fullDateLabel = calendarSelectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        const dayHeaderText = dayLabel === 'Today' || dayLabel === 'Tomorrow'
            ? `${dayLabel} — ${fullDateLabel}`
            : fullDateLabel;

        let eventsHtml = '';
        if (dayEvents.length === 0) {
            eventsHtml = '<div class="library-cal-no-events">No events</div>';
        } else {
            eventsHtml = dayEvents.map(item => {
                const idx = calendarItems.indexOf(item);
                return `
                    <div class="library-cal-event ${item.done ? 'done' : ''}" data-idx="${idx}">
                        <span class="library-cal-event-time">${formatTime12(item.time) || ''}</span>
                        <span class="library-cal-event-title">${escHtml(item.text)}</span>
                        <button class="library-cal-event-delete" data-idx="${idx}">&times;</button>
                    </div>`;
            }).join('');
        }

        el.innerHTML = `
            ${navHtml}
            ${quickAddHtml}
            <div class="library-cal-day-panel">
                <div class="library-cal-day-header">${dayHeaderText}</div>
                <div class="library-cal-day-events">${eventsHtml}</div>
            </div>
        `;

        // --- Event listeners ---
        // Day card clicks (week strip or month grid)
        el.querySelectorAll('[data-date]').forEach(card => {
            if (card.classList.contains('library-cal-month-header-cell')) return;
            card.addEventListener('click', () => {
                const [y, m, d] = card.dataset.date.split('-').map(Number);
                calendarSelectedDate = new Date(y, m - 1, d);
                renderCalendarContent(el);
            });
        });

        // Week/month navigation
        const prevBtn = document.getElementById('library-cal-prev');
        const nextBtn = document.getElementById('library-cal-next');
        if (prevBtn) prevBtn.addEventListener('click', () => {
            const offset = calendarViewMode === 'week' ? -7 : -28;
            calendarSelectedDate.setDate(calendarSelectedDate.getDate() + offset);
            renderCalendarContent(el);
        });
        if (nextBtn) nextBtn.addEventListener('click', () => {
            const offset = calendarViewMode === 'week' ? 7 : 28;
            calendarSelectedDate.setDate(calendarSelectedDate.getDate() + offset);
            renderCalendarContent(el);
        });

        // Toggle week/month
        const toggleBtn = document.getElementById('library-cal-toggle-mode');
        if (toggleBtn) toggleBtn.addEventListener('click', () => {
            calendarViewMode = calendarViewMode === 'week' ? 'month' : 'week';
            renderCalendarContent(el);
        });

        // Quick add
        const titleInput = document.getElementById('library-cal-title-input');
        const timeSelect = document.getElementById('library-cal-time-select');
        const addBtn = document.getElementById('library-cal-add-btn');

        function doAdd() {
            const title = titleInput.value.trim();
            if (!title) return;
            const date = selectedKey;
            const time = timeSelect.value;
            addCalendarEvent(date, time, title);
            titleInput.value = '';
            titleInput.focus();
        }

        if (titleInput) titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
        if (addBtn) addBtn.addEventListener('click', doAdd);

        // Event delete buttons
        el.querySelectorAll('.library-cal-event-delete').forEach(btn => {
            btn.addEventListener('click', () => deleteCalendarEvent(parseInt(btn.dataset.idx)));
        });
    }

    function focusCalendarInput() {
        const input = document.getElementById('library-cal-title-input');
        if (input) input.focus();
    }

    async function addCalendarEvent(date, time, title) {
        calendarBusy = true;
        const tempItem = { id: null, date: date || '', time: time || '', text: title, done: false };
        calendarItems.unshift(tempItem);
        renderCalendarList();
        updateCalendarBadge();

        try {
            const res = await fetch('/api/data/calendar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: date || '', time: time || '', text: title, done: false })
            });
            if (!res.ok) throw new Error('Failed');
            const created = await res.json();
            Object.assign(tempItem, created);
        } catch (e) {
            console.warn('Library: add calendar event failed', e);
            calendarItems = calendarItems.filter(i => i !== tempItem);
            renderCalendarList();
            updateCalendarBadge();
            alert('Failed to add event.');
        } finally {
            calendarBusy = false;
        }
    }

    async function toggleCalendarEvent(idx) {
        if (idx < 0 || idx >= calendarItems.length) return;
        calendarBusy = true;
        const item = calendarItems[idx];
        item.done = !item.done;
        renderCalendarList();
        updateCalendarBadge();

        if (item.id) {
            try {
                await fetch(`/api/data/calendar/${item.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ done: item.done })
                });
            } catch (e) {
                console.warn('Library: toggle calendar event failed', e);
                item.done = !item.done;
                renderCalendarList();
                updateCalendarBadge();
            }
        }
        calendarBusy = false;
    }

    async function deleteCalendarEvent(idx) {
        if (idx < 0 || idx >= calendarItems.length) return;
        if (!confirm('Delete this event?')) return;
        calendarBusy = true;
        const item = calendarItems[idx];
        calendarItems.splice(idx, 1);
        renderCalendarList();
        updateCalendarBadge();

        if (item.id) {
            try {
                const res = await fetch(`/api/data/calendar/${item.id}`, { method: 'DELETE' });
                if (!res.ok) throw new Error('Delete failed');
            } catch (e) {
                console.warn('Library: delete calendar event failed', e);
                calendarItems.splice(idx, 0, item);
                renderCalendarList();
                updateCalendarBadge();
                alert('Failed to delete event.');
            }
        }
        calendarBusy = false;
    }

    function updateCalendarBadge() {
        const badge = document.getElementById('calendar-badge');
        if (!badge) return;
        const today = todayStr();
        const count = calendarItems.filter(e => e.date === today && !e.done).length;
        badge.textContent = count;
        badge.style.display = count > 0 ? '' : 'none';
    }

    // =====================
    // --- IDEAS ---
    // =====================
    function renderNotesList() {
        const el = document.getElementById('library-notes-list');
        if (!el) return;
        const ideas = NotesService.getAll().filter(n => n.type !== 'todo')
            .sort((a, b) => (b.lastEdited || '').localeCompare(a.lastEdited || ''));
        if (ideas.length === 0) {
            el.innerHTML = '<div class="library-empty">No ideas yet. Tap + to add one.</div>';
            return;
        }
        el.innerHTML = ideas.map(n => {
            const isConverted = n.type === 'converted';
            const preview = n.hook || n.context || '';
            const badge = window.EggRenderer ? window.EggRenderer.projectBadgeHtml(n.project) : '';
            // Show actual pipeline status if converted
            let statusHtml = '';
            if (isConverted) {
                const linkedVideo = VideoService.getByIdeaId(n.id);
                if (linkedVideo && window.EggRenderer) {
                    statusHtml = ' ' + window.EggRenderer.statusBadgeHtml(linkedVideo.status);
                } else {
                    statusHtml = ' <span class="library-converted-badge-inline">Sent</span>';
                }
            }
            return `
            <div class="library-list-item ${isConverted ? 'converted' : ''}" data-note-id="${n.id}">
                <div class="library-list-item-content">
                    <div class="library-list-title">${escHtml(n.name)}${statusHtml}</div>
                    <div class="library-list-date">${badge}${!badge ? escHtml(preview ? preview.substring(0, 60) : 'idea') : ''}</div>
                </div>
                <button class="library-delete-btn" data-note-id="${n.id}" title="Delete">&times;</button>
            </div>`;
        }).join('');

        el.querySelectorAll('.library-list-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('library-delete-btn')) return;
                selectNote(item.dataset.noteId);
            });
        });
        el.querySelectorAll('.library-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); handleDeleteNote(btn.dataset.noteId); });
        });
    }

    function selectNote(id) {
        selectedNote = NotesService.getById(id);
        if (!selectedNote) return;
        showEditorPage();
        renderNoteEditor(selectedNote);
    }

    async function renderNoteEditor(note) {
        const editorEl = document.getElementById('library-editor');
        if (!editorEl) return;

        let projectOptions = '';
        try {
            const projs = await VideoService.getProjects();
            projectOptions = projs.map(p => `<option value="${escAttr(p)}" ${p === note.project ? 'selected' : ''}>${escHtml(p)}</option>`).join('');
        } catch (e) {}

        const isConverted = note.type === 'converted';
        let linkedVideo = null;
        if (isConverted) linkedVideo = VideoService.getByIdeaId(note.id);

        let incubatorSection = '';
        if (isConverted && linkedVideo) {
            const stBadge = window.EggRenderer ? window.EggRenderer.statusBadgeHtml(linkedVideo.status) : linkedVideo.status;
            incubatorSection = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">${stBadge}</div><div class="library-linked-video">Video: ${escHtml(linkedVideo.name)}</div>`;
        } else if (isConverted) {
            incubatorSection = `<div class="library-converted-badge">Sent to Incubator</div>`;
        } else {
            incubatorSection = `<button class="library-send-btn" id="library-send-incubator">Send to Incubator</button>`;
        }

        // Script field — inline textarea
        const scriptSection = `
            <div class="library-idea-field">
                <label class="library-idea-label">Script</label>
                <textarea class="library-idea-script" id="library-idea-script" placeholder="Write your script here...">${escHtml(note.script || '')}</textarea>
            </div>`;

        editorEl.innerHTML = `
            <div class="library-editor-toolbar">
                <button class="library-back-btn" id="library-back-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    Ideas
                </button>
                <span class="library-save-status saved" id="library-save-status">Saved</span>
            </div>
            <div class="library-editor-body">
                <div class="library-editor-title-row">
                    <input type="text" class="library-editor-title" id="library-editor-title" value="${escAttr(note.name)}" placeholder="Idea title..." />
                </div>
                <div class="library-meta-row">
                    <label class="library-meta-label">Project</label>
                    <select class="library-project-select" id="library-note-project">
                        <option value="">None (optional)</option>
                        ${projectOptions}
                    </select>
                </div>
                <div class="library-idea-field">
                    <label class="library-idea-label">Hook</label>
                    <textarea class="library-idea-hook" id="library-idea-hook" placeholder="What's the hook? (optional)">${escHtml(note.hook || '')}</textarea>
                </div>
                <div class="library-idea-field">
                    <label class="library-idea-label">Context</label>
                    <textarea class="library-idea-context" id="library-idea-context" placeholder="More details, angles, notes... (optional)">${escHtml(note.context || '')}</textarea>
                </div>
                ${scriptSection}
                <div class="library-incubator-section">${incubatorSection}</div>
            </div>
        `;
        document.getElementById('library-back-btn').addEventListener('click', () => saveNoteAndBack());
        document.getElementById('library-idea-hook').addEventListener('input', scheduleNoteSave);
        document.getElementById('library-idea-context').addEventListener('input', scheduleNoteSave);
        document.getElementById('library-idea-script').addEventListener('input', scheduleNoteSave);
        document.getElementById('library-editor-title').addEventListener('input', scheduleNoteSave);
        document.getElementById('library-note-project').addEventListener('change', scheduleNoteSave);
        const sendBtn = document.getElementById('library-send-incubator');
        if (sendBtn) sendBtn.addEventListener('click', () => sendToIncubator());
    }

    async function sendToIncubator() {
        if (!selectedNote) return;
        const existing = VideoService.getByIdeaId(selectedNote.id);
        if (existing) { alert('This idea has already been sent to the Incubator.'); return; }

        const name = document.getElementById('library-editor-title')?.value.trim() || selectedNote.name || 'Untitled';
        const hookEl = document.getElementById('library-idea-hook');
        const ctxEl = document.getElementById('library-idea-context');
        const projectEl = document.getElementById('library-note-project');
        const hook = hookEl?.value || '';
        const context = ctxEl?.value || '';
        const project = projectEl?.value || '';

        // Show sending overlay
        const sendBtn = document.getElementById('library-send-incubator');
        if (sendBtn) { sendBtn.textContent = 'Sending...'; sendBtn.disabled = true; }
        const overlay = document.createElement('div');
        overlay.className = 'library-sending-overlay';
        overlay.innerHTML = `<div class="library-sending-content"><div class="library-sending-egg">&#129370;</div><div class="library-sending-text">Sending to Incubator...</div></div>`;
        const editorBody = document.querySelector('.library-editor-body');
        if (editorBody) editorBody.style.position = 'relative';
        if (editorBody) editorBody.appendChild(overlay);

        // Haptic feedback
        if (navigator.vibrate) navigator.vibrate(50);

        try {
            const scriptEl = document.getElementById('library-idea-script');
            const script = scriptEl?.value || selectedNote.script || '';
            const video = await VideoService.create({ name, hook, context, script, project, sourceIdeaId: selectedNote.id });
            await NotesService.update(selectedNote.id, { type: 'converted' });

            // Success animation
            overlay.querySelector('.library-sending-text').textContent = 'Sent!';
            overlay.classList.add('sent');
            if (navigator.vibrate) navigator.vibrate([30, 50, 30]);

            await new Promise(r => setTimeout(r, 800));
            overlay.remove();

            selectedNote = NotesService.getById(selectedNote.id);
            renderNoteEditor(selectedNote);
        } catch (e) {
            console.warn('Library: send to incubator failed', e);
            overlay.remove();
            if (sendBtn) { sendBtn.textContent = 'Send to Incubator'; sendBtn.disabled = false; }
            alert('Failed to send to Incubator. Check connection.');
        }
    }

    function scheduleNoteSave() {
        noteDirty = true; setSaveStatus('Editing...');
        if (noteSaveTimer) clearTimeout(noteSaveTimer);
        noteSaveTimer = setTimeout(() => saveNote(), 1500);
    }

    async function saveNote() {
        if (!selectedNote || !noteDirty) return;
        const titleEl = document.getElementById('library-editor-title');
        const hookEl = document.getElementById('library-idea-hook');
        const ctxEl = document.getElementById('library-idea-context');
        const projectEl = document.getElementById('library-note-project');
        if (!titleEl) return;
        setSaveStatus('Saving...'); noteDirty = false;
        try {
            const newName = titleEl.value.trim() || 'Untitled';
            const newHook = hookEl?.value || '';
            const newContext = ctxEl?.value || '';
            const newProject = projectEl?.value || '';
            const scriptEl = document.getElementById('library-idea-script');
            const newScript = scriptEl?.value || '';
            await NotesService.update(selectedNote.id, {
                name: newName,
                hook: newHook,
                context: newContext,
                script: newScript,
                project: newProject
            });
            selectedNote = NotesService.getById(selectedNote.id);
            // Bidirectional sync: if this idea has a linked video, update it too
            const linkedVideo = VideoService.getByIdeaId(selectedNote.id);
            if (linkedVideo) {
                VideoService.update(linkedVideo.id, { name: newName, hook: newHook, context: newContext, project: newProject }).catch(() => {});
            }
            setSaveStatus('Saved');
        } catch (e) { setSaveStatus('Save failed'); noteDirty = true; }
    }

    async function saveNoteAndBack() {
        if (noteDirty && selectedNote) await saveNote();
        selectedNote = null;
        showListPage();
        renderNotesList();
    }

    async function handleNewNote() {
        try {
            const note = await NotesService.create({ name: 'Untitled', type: 'idea' });
            selectedNote = note;
            showEditorPage();
            await renderNoteEditor(note);
            const titleInput = document.getElementById('library-editor-title');
            if (titleInput) { titleInput.focus(); titleInput.select(); }
        } catch (e) {
            console.warn('Library: create note failed', e);
            alert('Failed to create idea. Check connection.');
        }
    }

    async function handleDeleteNote(id) {
        const note = NotesService.getById(id);
        if (!note || !confirm(`Delete "${note.name}"?`)) return;
        try {
            await NotesService.remove(id);
            if (selectedNote && selectedNote.id === id) { selectedNote = null; if (currentPage === 'editor') showListPage(); }
            renderNotesList();
        } catch (e) { console.warn('Library: delete note failed', e); }
    }

    // =====================
    // --- VIDEO EDITOR (from Projects tab) ---
    // =====================

    function openVideoEditor(videoId) {
        selectedVideo = VideoService.getById(videoId);
        if (!selectedVideo) return;
        showEditorPage();
        renderVideoEditor();
    }

    async function renderVideoEditor() {
        const editorEl = document.getElementById('library-editor');
        if (!editorEl || !selectedVideo) return;
        const v = selectedVideo;

        const statusBadge = window.EggRenderer ? window.EggRenderer.statusBadgeHtml(v.status) : v.status;

        let projectOptions = '';
        try {
            const projs = await VideoService.getProjects();
            projectOptions = projs.map(p => `<option value="${escAttr(p)}" ${p === v.project ? 'selected' : ''}>${escHtml(p)}</option>`).join('');
        } catch (e) {}

        // Script field — inline textarea
        const scriptSection = `
            <div class="library-idea-field">
                <label class="library-idea-label">Script</label>
                <textarea class="library-idea-script" id="library-video-script" placeholder="Write your script here...">${escHtml(v.script || '')}</textarea>
            </div>`;

        // Source idea badge
        let sourceIdeaHtml = '';
        if (v.sourceIdeaId) {
            const idea = NotesService.getById(v.sourceIdeaId);
            sourceIdeaHtml = `<div class="library-converted-badge">Source Idea: ${escHtml(idea ? idea.name : 'Unknown')}</div>`;
        }

        editorEl.innerHTML = `
            <div class="library-editor-toolbar">
                <button class="library-back-btn" id="library-back-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    Back
                </button>
                <span class="library-save-status saved" id="library-save-status">Saved</span>
            </div>
            <div class="library-editor-body">
                <div class="library-editor-title-row">
                    <input type="text" class="library-editor-title" id="library-editor-title" value="${escAttr(v.name)}" placeholder="Video title..." />
                </div>
                <div style="margin-bottom:8px;">${statusBadge}</div>
                ${sourceIdeaHtml}
                <div class="library-meta-row">
                    <label class="library-meta-label">Project</label>
                    <select class="library-project-select" id="library-video-project">
                        <option value="">No project</option>
                        ${projectOptions}
                    </select>
                </div>
                <div class="library-idea-field">
                    <label class="library-idea-label">Hook</label>
                    <textarea class="library-idea-hook" id="library-video-hook" placeholder="What's the hook?">${escHtml(v.hook || '')}</textarea>
                </div>
                <div class="library-idea-field">
                    <label class="library-idea-label">Context</label>
                    <textarea class="library-idea-context" id="library-video-context" placeholder="More details, angles, notes...">${escHtml(v.context || '')}</textarea>
                </div>
                ${scriptSection}
            </div>
        `;

        document.getElementById('library-back-btn').addEventListener('click', () => saveVideoAndBack());
        document.getElementById('library-editor-title').addEventListener('input', scheduleVideoSave);
        document.getElementById('library-video-hook').addEventListener('input', scheduleVideoSave);
        document.getElementById('library-video-context').addEventListener('input', scheduleVideoSave);
        document.getElementById('library-video-script').addEventListener('input', scheduleVideoSave);
        document.getElementById('library-video-project').addEventListener('change', scheduleVideoSave);
    }

    function scheduleVideoSave() {
        videoDirty = true; setSaveStatus('Editing...');
        if (videoSaveTimer) clearTimeout(videoSaveTimer);
        videoSaveTimer = setTimeout(() => saveVideo(), 1500);
    }

    async function saveVideo() {
        if (!selectedVideo || !videoDirty) return;
        const titleEl = document.getElementById('library-editor-title');
        const hookEl = document.getElementById('library-video-hook');
        const ctxEl = document.getElementById('library-video-context');
        const projectEl = document.getElementById('library-video-project');
        if (!titleEl) return;
        setSaveStatus('Saving...'); videoDirty = false;
        try {
            const name = titleEl.value.trim() || 'Untitled';
            const hook = hookEl?.value || '';
            const context = ctxEl?.value || '';
            const project = projectEl?.value || '';
            const scriptEl = document.getElementById('library-video-script');
            const script = scriptEl?.value || '';
            await VideoService.saveWithIdeaSync(selectedVideo.id, { name, hook, context, script, project });
            selectedVideo = VideoService.getById(selectedVideo.id);
            setSaveStatus('Saved');
        } catch (e) { setSaveStatus('Save failed'); videoDirty = true; }
    }

    async function saveVideoAndBack() {
        if (videoDirty && selectedVideo) await saveVideo();
        selectedVideo = null;
        showListPage();
        // Return to projects tab
        switchTab('projects');
    }

    // =====================
    // --- PROJECTS ---
    // =====================
    let projectsLoaded = false;
    let selectedProject = null;
    async function renderProjectsList() {
        const el = document.getElementById('library-projects-container');
        if (!el) return;

        if (!projectsLoaded) {
            el.innerHTML = '<div class="library-empty">Loading projects...</div>';
            try {
                await VideoService.getProjects();
                projectsLoaded = true;
                renderProjectsList();
            } catch (e) {
                el.innerHTML = '<div class="library-empty">Could not load projects.</div>';
            }
            return;
        }

        if (selectedProject) {
            renderProjectDetail(el);
            return;
        }

        const projs = VideoService.getCachedProjects();
        if (projs.length === 0) {
            el.innerHTML = '<div class="library-empty">No projects found in Dropbox.</div>';
            return;
        }

        el.innerHTML = projs.map(p => {
            const videoCount = VideoService.getByProject(p).length;
            const ideaCount = NotesService.getByProject(p).length;
            const counts = [];
            if (videoCount) counts.push(`${videoCount} video${videoCount !== 1 ? 's' : ''}`);
            if (ideaCount) counts.push(`${ideaCount} idea${ideaCount !== 1 ? 's' : ''}`);
            const color = window.EggRenderer ? window.EggRenderer.getProjectColor(p) : '#ccc';
            const rectFlag = window.EggRenderer ? window.EggRenderer.projectFlagSvg(p, 32, true) : '';
            return `
            <div class="library-project-card" data-project="${escAttr(p)}" style="border-left:3px solid ${color}">
                ${rectFlag ? `<div class="library-project-flag">${rectFlag}</div>` : ''}
                <div class="library-list-item-content">
                    <div class="library-list-title">${escHtml(p)}</div>
                    <div class="library-list-date">${counts.length ? counts.join(' / ') : 'No items yet'}</div>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#999" stroke-width="2"><polyline points="9 6 15 12 9 18"></polyline></svg>
            </div>`;
        }).join('');

        el.querySelectorAll('.library-project-card').forEach(card => {
            card.addEventListener('click', () => {
                selectedProject = card.dataset.project;
                renderProjectsList();
            });
        });
    }

    function renderProjectDetail(el) {
        if (!el || !selectedProject) return;
        const p = selectedProject;

        const projectVideos = VideoService.getByProject(p);
        const projectIdeas = NotesService.getByProject(p);

        const statusLabel = (s) => s === 'incubator' ? 'Incubator' : s === 'workshop' ? 'Workshop' : s === 'posted' ? 'Posted' : s;

        let html = `
            <div class="library-project-detail-header">
                <button class="library-back-btn" id="library-project-back">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    Projects
                </button>
            </div>
            <div class="library-project-detail-title">${escHtml(p)}</div>
        `;

        // Videos section — show linked script under each video
        html += `<div class="library-project-section"><div class="library-project-section-header">Videos (${projectVideos.length})</div>`;
        if (projectVideos.length === 0) {
            html += '<div class="library-project-section-empty">No videos in this project</div>';
        } else {
            html += projectVideos.map(v => {
                const hasScript = v.script ? '<span style="font-size:11px;color:#888;margin-left:6px;">has script</span>' : '';
                return `
                <div class="library-project-item library-project-item-clickable" data-video-id="${v.id}">
                    <span class="library-project-item-name">${escHtml(v.name)}${hasScript}</span>
                    <span class="library-project-item-status status-${v.status}">${statusLabel(v.status)}</span>
                </div>`;
            }).join('');
        }
        html += '</div>';

        // Ideas section — show linked script under each idea
        html += `<div class="library-project-section"><div class="library-project-section-header">Ideas (${projectIdeas.length})</div>`;
        if (projectIdeas.length === 0) {
            html += '<div class="library-project-section-empty">No ideas in this project</div>';
        } else {
            html += projectIdeas.map(n => {
                const hasScript = n.script ? '<span style="font-size:11px;color:#888;margin-left:6px;">has script</span>' : '';
                return `
                <div class="library-project-item library-project-item-clickable" data-note-id="${n.id}">
                    <span class="library-project-item-name">${escHtml(n.name)}${hasScript}</span>
                    <span class="library-project-item-status">${n.type === 'converted' ? 'Sent' : 'Idea'}</span>
                </div>`;
            }).join('');
        }
        html += '</div>';

        // Add Idea button
        html += `<div class="library-project-actions"><button class="library-send-btn" id="library-project-add-note">+ Add Idea</button></div>`;

        el.innerHTML = html;

        // Event listeners
        document.getElementById('library-project-back').addEventListener('click', () => {
            selectedProject = null;
            renderProjectsList();
        });

        el.querySelectorAll('[data-video-id]').forEach(item => {
            item.addEventListener('click', () => {
                openVideoEditor(item.dataset.videoId);
            });
        });

        el.querySelectorAll('[data-note-id]').forEach(item => {
            item.addEventListener('click', () => {
                switchTab('notes');
                selectNote(item.dataset.noteId);
            });
        });

        document.getElementById('library-project-add-note').addEventListener('click', async () => {
            try {
                const note = await NotesService.create({ name: 'Untitled', type: 'idea', project: p });
                switchTab('notes');
                selectedNote = note;
                showEditorPage();
                await renderNoteEditor(note);
                const titleInput = document.getElementById('library-editor-title');
                if (titleInput) { titleInput.focus(); titleInput.select(); }
            } catch (e) {
                console.warn('Library: create note for project failed', e);
                alert('Failed to create note.');
            }
        });
    }

    function updateTodoBadge() {
        const badge = document.getElementById('todo-badge');
        if (!badge) return;
        const count = todoItems.filter(i => !i.done).length;
        badge.textContent = count;
        badge.style.display = count > 0 ? '' : 'none';
    }

    // =====================
    // --- INVOICES (R2-backed records) ---
    // =====================

    async function fetchInvoices() {
        const res = await fetch('/api/data/invoices');
        if (!res.ok) return [];
        return await res.json();
    }

    function toCAD(amount, currency) {
        const rate = CAD_RATES[currency] || 1;
        return amount * rate;
    }

    function getExpectedIncomeCADInternal() {
        return invoiceItems
            .filter(i => !i.paid)
            .reduce((sum, i) => sum + toCAD(i.amount, i.currency), 0);
    }

    function renderInvoicesList() {
        const el = document.getElementById('library-invoices-container');
        if (!el) return;
        if (!invoicesLoaded) {
            el.innerHTML = '<div class="library-empty">Loading invoices...</div>';
            fetchInvoices().then(items => {
                invoiceItems = items;
                invoicesLoaded = true;
                renderInvoicesList();
                updateInvoicesBadge();
                if (typeof updateFinanceDisplay === 'function') updateFinanceDisplay();
            }).catch(() => {
                el.innerHTML = '<div class="library-empty">Could not load invoices.</div>';
            });
            return;
        }
        renderInvoicesContent(el);
    }

    function backgroundRefreshInvoices() {
        if (invoicesBusy) return;
        fetchInvoices().then(fresh => {
            if (invoicesBusy) return;
            if (fresh && fresh.length >= 0) {
                invoiceItems = fresh;
                updateInvoicesBadge();
                if (typeof updateFinanceDisplay === 'function') updateFinanceDisplay();
                const el = document.getElementById('library-invoices-container');
                if (el) renderInvoicesContent(el);
            }
        }).catch(() => {});
    }

    function renderInvoicesContent(el) {
        if (!el) return;

        const unpaid = invoiceItems.filter(i => !i.paid);
        const paid = invoiceItems.filter(i => i.paid);
        const totalCAD = getExpectedIncomeCADInternal();

        const currencies = Object.keys(CAD_RATES);
        const todayStr2 = new Date().toISOString().slice(0, 10);

        let html = `
            <div class="library-invoice-total">
                Expected: <strong>$${Math.round(totalCAD).toLocaleString()} CAD</strong>
                <span style="color:#888;font-size:12px;margin-left:6px;">(${unpaid.length} unpaid)</span>
            </div>
            <div class="library-invoice-form">
                <input type="text" class="library-invoice-input" id="library-invoice-company" placeholder="Company name" />
                <input type="number" class="library-invoice-input library-invoice-amount-input" id="library-invoice-amount" placeholder="Amount" step="0.01" min="0" />
                <select class="library-invoice-select" id="library-invoice-currency">
                    ${currencies.map(c => `<option value="${c}">${c}</option>`).join('')}
                </select>
                <input type="date" class="library-invoice-input" id="library-invoice-date" value="${todayStr2}" />
                <input type="text" class="library-invoice-input" id="library-invoice-notes" placeholder="Notes (optional)" />
                <button class="library-invoice-add-btn" id="library-invoice-add-btn">Add</button>
            </div>
        `;

        if (unpaid.length === 0 && paid.length === 0) {
            html += '<div class="library-empty">No invoices yet. Add one above.</div>';
        }

        if (unpaid.length > 0) {
            html += '<div class="library-todo-section-header">Unpaid</div>';
            html += unpaid.map(item => {
                const idx = invoiceItems.indexOf(item);
                const cadAmt = toCAD(item.amount, item.currency);
                const cadNote = item.currency !== 'CAD' ? ` <span style="color:#888;font-size:12px;">(~$${Math.round(cadAmt).toLocaleString()} CAD)</span>` : '';
                const dateStr = item.expectedDate ? formatCalDate(item.expectedDate) : '';
                return `
                    <div class="library-invoice-item" data-idx="${idx}">
                        <div class="library-invoice-info">
                            <div class="library-invoice-company">${escHtml(item.company)}</div>
                            <div class="library-invoice-details">
                                <span class="library-invoice-amount-display">$${item.amount.toLocaleString(undefined, {minimumFractionDigits: 2})} ${escHtml(item.currency)}${cadNote}</span>
                                ${dateStr ? `<span class="library-invoice-date">${dateStr}</span>` : ''}
                                ${item.notes ? `<span class="library-invoice-notes-text">${escHtml(item.notes)}</span>` : ''}
                            </div>
                        </div>
                        <div class="library-invoice-actions">
                            <button class="library-invoice-paid-btn" data-idx="${idx}" title="Mark paid">&#10003;</button>
                            <button class="library-invoice-delete-btn" data-idx="${idx}" title="Delete">&times;</button>
                        </div>
                    </div>`;
            }).join('');
        }

        if (paid.length > 0) {
            html += `<div class="library-todo-section-header" style="cursor:pointer;" id="library-invoices-paid-toggle">Paid (${paid.length}) &#9662;</div>`;
            html += `<div id="library-invoices-paid-section" style="display:none;">`;
            html += paid.map(item => {
                const idx = invoiceItems.indexOf(item);
                return `
                    <div class="library-invoice-item library-invoice-paid" data-idx="${idx}">
                        <div class="library-invoice-info">
                            <div class="library-invoice-company">${escHtml(item.company)}</div>
                            <div class="library-invoice-details">
                                <span class="library-invoice-amount-display">$${item.amount.toLocaleString(undefined, {minimumFractionDigits: 2})} ${escHtml(item.currency)}</span>
                                ${item.notes ? `<span class="library-invoice-notes-text">${escHtml(item.notes)}</span>` : ''}
                            </div>
                        </div>
                        <div class="library-invoice-actions">
                            <button class="library-invoice-delete-btn" data-idx="${idx}" title="Delete">&times;</button>
                        </div>
                    </div>`;
            }).join('');
            html += `</div>`;
        }

        el.innerHTML = html;

        // Event listeners
        const addBtn = document.getElementById('library-invoice-add-btn');
        if (addBtn) addBtn.addEventListener('click', addInvoice);

        // Enter key on inputs
        ['library-invoice-company', 'library-invoice-amount', 'library-invoice-notes'].forEach(id => {
            const inp = document.getElementById(id);
            if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') addInvoice(); });
        });

        el.querySelectorAll('.library-invoice-paid-btn').forEach(btn => {
            btn.addEventListener('click', () => toggleInvoicePaid(parseInt(btn.dataset.idx)));
        });
        el.querySelectorAll('.library-invoice-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteInvoice(parseInt(btn.dataset.idx)));
        });

        const paidToggle = document.getElementById('library-invoices-paid-toggle');
        if (paidToggle) {
            paidToggle.addEventListener('click', () => {
                const section = document.getElementById('library-invoices-paid-section');
                if (section) {
                    const showing = section.style.display !== 'none';
                    section.style.display = showing ? 'none' : '';
                    paidToggle.innerHTML = `Paid (${paid.length}) ${showing ? '&#9662;' : '&#9652;'}`;
                }
            });
        }
    }

    async function addInvoice() {
        const companyEl = document.getElementById('library-invoice-company');
        const amountEl = document.getElementById('library-invoice-amount');
        const currencyEl = document.getElementById('library-invoice-currency');
        const dateEl = document.getElementById('library-invoice-date');
        const notesEl = document.getElementById('library-invoice-notes');

        const company = (companyEl && companyEl.value.trim()) || '';
        const amount = amountEl ? parseFloat(amountEl.value) : 0;
        const currency = currencyEl ? currencyEl.value : 'CAD';
        const expectedDate = dateEl ? dateEl.value : '';
        const notes = (notesEl && notesEl.value.trim()) || '';

        if (!company || !amount) { alert('Company and amount are required.'); return; }

        invoicesBusy = true;
        const tempItem = { id: null, company, amount, currency, expectedDate, notes, paid: false };
        invoiceItems.unshift(tempItem);

        // Clear form
        if (companyEl) companyEl.value = '';
        if (amountEl) amountEl.value = '';
        if (notesEl) notesEl.value = '';

        renderInvoicesList();
        updateInvoicesBadge();
        if (typeof updateFinanceDisplay === 'function') updateFinanceDisplay();

        try {
            const res = await fetch('/api/data/invoices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ company, amount, currency, expectedDate, notes, paid: false })
            });
            if (!res.ok) throw new Error('Failed');
            const created = await res.json();
            Object.assign(tempItem, created);
        } catch (e) {
            console.warn('Library: add invoice failed', e);
            invoiceItems = invoiceItems.filter(i => i !== tempItem);
            renderInvoicesList();
            updateInvoicesBadge();
            if (typeof updateFinanceDisplay === 'function') updateFinanceDisplay();
            alert('Failed to add invoice. Check connection.');
        } finally {
            invoicesBusy = false;
        }
    }

    async function toggleInvoicePaid(idx) {
        if (idx < 0 || idx >= invoiceItems.length) return;
        invoicesBusy = true;
        const item = invoiceItems[idx];
        item.paid = !item.paid;
        renderInvoicesList();
        updateInvoicesBadge();
        if (typeof updateFinanceDisplay === 'function') updateFinanceDisplay();

        if (item.id) {
            try {
                await fetch(`/api/data/invoices/${item.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ paid: item.paid })
                });
            } catch (e) {
                console.warn('Library: toggle invoice failed', e);
                item.paid = !item.paid;
                renderInvoicesList();
                updateInvoicesBadge();
                if (typeof updateFinanceDisplay === 'function') updateFinanceDisplay();
            }
        }
        invoicesBusy = false;
    }

    async function deleteInvoice(idx) {
        if (idx < 0 || idx >= invoiceItems.length) return;
        if (!confirm('Delete this invoice?')) return;
        invoicesBusy = true;
        const item = invoiceItems[idx];
        invoiceItems.splice(idx, 1);
        renderInvoicesList();
        updateInvoicesBadge();
        if (typeof updateFinanceDisplay === 'function') updateFinanceDisplay();

        if (item.id) {
            try {
                const res = await fetch(`/api/data/invoices/${item.id}`, { method: 'DELETE' });
                if (!res.ok) throw new Error('Delete failed');
            } catch (e) {
                console.warn('Library: delete invoice failed', e);
                invoiceItems.splice(idx, 0, item);
                renderInvoicesList();
                updateInvoicesBadge();
                if (typeof updateFinanceDisplay === 'function') updateFinanceDisplay();
                alert('Failed to delete invoice. It has been restored.');
            }
        }
        invoicesBusy = false;
    }

    function updateInvoicesBadge() {
        const badge = document.getElementById('invoices-badge');
        if (!badge) return;
        const count = invoiceItems.filter(i => !i.paid).length;
        badge.textContent = count;
        badge.style.display = count > 0 ? '' : 'none';
    }

    return {
        async open(bodyEl, opts) {
            await loadConfig();
            render(bodyEl);
            await NotesService.sync().catch(() => {});
            renderNotesList();
            if (opts && opts.tab) switchTab(opts.tab);
        },
        close() {
            if (noteSaveTimer) { clearTimeout(noteSaveTimer); saveNote(); }
            if (videoSaveTimer) { clearTimeout(videoSaveTimer); saveVideo(); }
            container = null; selectedNote = null;
            selectedVideo = null; videoDirty = false;
            noteDirty = false;
            // Keep todoLoaded/todoItems, calendarLoaded/calendarItems, invoicesLoaded/invoiceItems cached across close/open
            calendarViewMode = 'week'; calendarSelectedDate = null;
            invoicesLoaded = false;
            projectsLoaded = false; selectedProject = null;
            currentPage = 'list'; activeTab = 'notes';
        },
        // Public: preload to-do count for badge (called on page load)
        async preloadTodoCount() {
            await loadConfig();
            if (!todoLoaded) {
                try {
                    todoItems = await fetchTodoItems();
                    todoLoaded = true;
                } catch (e) {}
            }
            updateTodoBadge();
        },
        getTodoCount() {
            return todoItems.filter(i => !i.done).length;
        },
        // Public: preload calendar count for HUD badge
        async preloadCalendarCount() {
            await loadConfig();
            if (!calendarLoaded) {
                try {
                    calendarItems = await fetchCalendarEvents();
                    calendarLoaded = true;
                } catch (e) {}
            }
            updateCalendarBadge();
        },
        getCalendarTodayCount() {
            const today = todayStr();
            return calendarItems.filter(e => e.date === today && !e.done).length;
        },
        // Public: preload invoices count for HUD badge + expected income
        async preloadInvoicesCount() {
            await loadConfig();
            if (!invoicesLoaded) {
                try {
                    invoiceItems = await fetchInvoices();
                    invoicesLoaded = true;
                } catch (e) {}
            }
            updateInvoicesBadge();
            if (typeof updateFinanceDisplay === 'function') updateFinanceDisplay();
        },
        getExpectedIncomeCAD() {
            return getExpectedIncomeCADInternal();
        },
        getInvoicesBadgeCount() {
            return invoiceItems.filter(i => !i.paid).length;
        }
    };
})();

BuildingRegistry.register('Library', {
    open: (bodyEl, opts) => LibraryUI.open(bodyEl, opts),
    close: () => LibraryUI.close()
});
