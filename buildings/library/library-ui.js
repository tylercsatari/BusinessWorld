/**
 * Library UI — Ideas, To-Do list, Calendar, Projects, Sponsors.
 * All data stored in R2 JSON files via /api/data/* routes.
 * Scripts are now embedded in ideas (idea.script field).
 */
const LibraryUI = (() => {
    let container = null;
    // --- Sponsors state ---
    let sponsorCompanies = [];   // [{id, name, address, notes, companyStatus}]
    let sponsorVideos = [];      // [{id, companyId, title, amount, currency, status, dueDate, deliverables, notes, invoiceId}]
    let sponsorsLoaded = false;
    let sponsorsBusy = false;
    let sponsorsSubTab = 'companies'; // 'companies' | 'videos'
    let editingSponsor = null;   // company id being edited, or 'new'
    let editingSponsorVideo = null; // video deal id being edited, or 'new'
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

    // --- Free Notes state ---
    let freeNotes = [];
    let freeNotesLoaded = false;
    let freeNotesBusy = false;
    let selectedFreeNote = null;
    let freeNoteSaveTimer = null;
    let freeNoteDirty = false;

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
        if (activeTab === 'freenotes') renderFreeNotesList();
        else if (activeTab === 'notes') renderNotesList();
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
                        <button class="library-tab" data-tab="freenotes">Notes</button>
                        <button class="library-tab active" data-tab="notes">Ideas</button>
                        <button class="library-tab" data-tab="todo">To-Do</button>
                        <button class="library-tab" data-tab="calendar">Calendar</button>
                        <button class="library-tab" data-tab="projects">Projects</button>
                        <button class="library-tab" data-tab="sponsors">Sponsors</button>
                        <button class="library-tab" data-tab="ideamap">Idea Map</button>
                    </div>
                    <div class="library-list-header" id="library-list-header">
                        <h2 class="library-list-heading" id="library-list-heading">Ideas</h2>
                        <button class="library-new-btn" id="library-new-btn" title="New">+</button>
                    </div>
                    <div class="library-freenotes-list" id="library-freenotes-list" style="display:none;"></div>
                    <div class="library-notes-list" id="library-notes-list">${Array(4).fill('<div class="library-skeleton-item"><div class="library-skeleton-icon"></div><div class="library-skeleton-text"><div class="library-skeleton-line"></div><div class="library-skeleton-line short"></div></div></div>').join('')}</div>
                    <div class="library-todo-container" id="library-todo-container" style="display:none;"></div>
                    <div class="library-calendar-container" id="library-calendar-container" style="display:none;"></div>
                    <div class="library-projects-container" id="library-projects-container" style="display:none;"></div>
                    <div class="library-sponsors-container" id="library-sponsors-container" style="display:none;"></div>
                    <div class="library-ideamap-container" id="library-ideamap-container" style="display:none;"></div>
                </div>
                <div class="library-page library-editor-page" id="library-editor-page">
                    <div class="library-editor" id="library-editor">
                        <div class="library-editor-empty"><div class="library-editor-empty-icon">📝</div><div>Select a script or create a new one</div></div>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('library-new-btn').addEventListener('click', () => {
            if (activeTab === 'freenotes') handleNewFreeNote();
            else if (activeTab === 'notes') handleNewNote();
            else if (activeTab === 'todo') focusTodoInput();
            else if (activeTab === 'calendar') focusCalendarInput();
            else if (activeTab === 'sponsors') {
                if (sponsorsSubTab === 'companies') { editingSponsor = 'new'; renderSponsorsTab(); }
                else { editingSponsorVideo = 'new'; renderSponsorsTab(); }
            }
        });
        container.querySelectorAll('.library-tab').forEach(tab => {
            tab.addEventListener('click', () => switchTab(tab.dataset.tab));
        });
    }

    function switchTab(tab) {
        activeTab = tab;
        container.querySelectorAll('.library-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        const heading = document.getElementById('library-list-heading');
        const freeNotesList = document.getElementById('library-freenotes-list');
        const notesList = document.getElementById('library-notes-list');
        const todoContainer = document.getElementById('library-todo-container');
        const calendarContainer = document.getElementById('library-calendar-container');
        const projectsContainer = document.getElementById('library-projects-container');
        const sponsorsContainer = document.getElementById('library-sponsors-container');
        const ideamapContainer = document.getElementById('library-ideamap-container');

        if (freeNotesList) freeNotesList.style.display = 'none';
        if (notesList) notesList.style.display = 'none';
        if (todoContainer) todoContainer.style.display = 'none';
        if (calendarContainer) calendarContainer.style.display = 'none';
        if (projectsContainer) projectsContainer.style.display = 'none';
        if (sponsorsContainer) sponsorsContainer.style.display = 'none';
        if (ideamapContainer) ideamapContainer.style.display = 'none';

        const newBtn = document.getElementById('library-new-btn');

        if (tab === 'freenotes') {
            if (heading) heading.textContent = 'Notes';
            if (freeNotesList) freeNotesList.style.display = '';
            if (newBtn) newBtn.style.display = '';
            renderFreeNotesList();
        } else if (tab === 'notes') {
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
        } else if (tab === 'sponsors') {
            if (heading) heading.textContent = 'Sponsors';
            if (sponsorsContainer) sponsorsContainer.style.display = '';
            if (newBtn) newBtn.style.display = '';
            renderSponsorsTab();
            if (sponsorsLoaded) backgroundRefreshSponsors();
        } else if (tab === 'ideamap') {
            if (heading) heading.textContent = 'Idea Map';
            if (ideamapContainer) ideamapContainer.style.display = '';
            if (newBtn) newBtn.style.display = 'none';
            const header = document.getElementById('library-list-header');
            if (header) header.style.display = 'none';
            renderIdeaMap();
        }
        // Re-show header for non-ideamap tabs
        if (tab !== 'ideamap') {
            const header = document.getElementById('library-list-header');
            if (header) header.style.display = '';
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
    // --- FREE NOTES ---
    // =====================

    async function fetchFreeNotes() {
        const res = await fetch('/api/data/notes');
        if (!res.ok) return [];
        return await res.json();
    }

    function renderFreeNotesList() {
        const el = document.getElementById('library-freenotes-list');
        if (!el) return;

        if (!freeNotesLoaded) {
            el.innerHTML = '<div class="library-empty">Loading notes...</div>';
            fetchFreeNotes().then(items => {
                freeNotes = items;
                freeNotesLoaded = true;
                renderFreeNotesList();
            }).catch(() => {
                el.innerHTML = '<div class="library-empty">Could not load notes.</div>';
            });
            return;
        }

        // Sort: pinned first, then by lastEdited descending
        const sorted = [...freeNotes].sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return (b.lastEdited || b.createdAt || '').localeCompare(a.lastEdited || a.createdAt || '');
        });

        if (sorted.length === 0) {
            el.innerHTML = '<div class="library-empty">No notes yet. Tap + to create one.</div>';
            return;
        }

        el.innerHTML = sorted.map(n => {
            const preview = (n.body || '').substring(0, 80).replace(/\n/g, ' ');
            const pinIcon = n.pinned ? '<span class="library-freenote-pin" title="Pinned">&#128204;</span> ' : '';
            let metaHtml = '';
            if (n.linkedProject) {
                const badge = window.EggRenderer ? window.EggRenderer.projectBadgeHtml(n.linkedProject) : escHtml(n.linkedProject);
                metaHtml += badge;
            }
            if (n.linkedIdeaId) {
                const idea = NotesService.getById(n.linkedIdeaId);
                if (idea) metaHtml += `<span class="library-freenote-linked-idea">${escHtml(idea.name)}</span>`;
            }
            return `
            <div class="library-list-item" data-freenote-id="${n.id}">
                <div class="library-list-item-content">
                    <div class="library-list-title">${pinIcon}${escHtml(n.title || 'Untitled')}</div>
                    <div class="library-list-date">${metaHtml || escHtml(preview || 'Empty note')}</div>
                </div>
                <button class="library-delete-btn" data-freenote-id="${n.id}" title="Delete">&times;</button>
            </div>`;
        }).join('');

        el.querySelectorAll('.library-list-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('library-delete-btn')) return;
                selectFreeNote(item.dataset.freenoteId);
            });
        });
        el.querySelectorAll('.library-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); handleDeleteFreeNote(btn.dataset.freenoteId); });
        });
    }

    function selectFreeNote(id) {
        selectedFreeNote = freeNotes.find(n => n.id === id);
        if (!selectedFreeNote) return;
        showEditorPage();
        renderFreeNoteEditor(selectedFreeNote);
    }

    async function renderFreeNoteEditor(note) {
        const editorEl = document.getElementById('library-editor');
        if (!editorEl) return;

        // Project dropdown
        let projectOptions = '';
        try {
            const projs = await VideoService.getProjects();
            projectOptions = projs.map(p => `<option value="${escAttr(p)}" ${p === note.linkedProject ? 'selected' : ''}>${escHtml(p)}</option>`).join('');
        } catch (e) {}

        // Idea dropdown
        const ideas = NotesService.getAll().filter(n => n.type !== 'todo');
        const ideaOptions = ideas.map(i => `<option value="${escAttr(i.id)}" ${i.id === note.linkedIdeaId ? 'selected' : ''}>${escHtml(i.name)}</option>`).join('');

        editorEl.innerHTML = `
            <div class="library-editor-toolbar">
                <button class="library-back-btn" id="library-back-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    Notes
                </button>
                <div class="library-freenote-toolbar-right">
                    <button class="library-freenote-pin-btn ${note.pinned ? 'pinned' : ''}" id="library-freenote-pin" title="${note.pinned ? 'Unpin' : 'Pin to top'}">&#128204;</button>
                    <span class="library-save-status saved" id="library-save-status">Saved</span>
                </div>
            </div>
            <div class="library-editor-body">
                <div class="library-editor-title-row">
                    <input type="text" class="library-editor-title" id="library-freenote-title" value="${escAttr(note.title || '')}" placeholder="Note title..." />
                </div>
                <div class="library-meta-row">
                    <label class="library-meta-label">Project</label>
                    <select class="library-project-select" id="library-freenote-project">
                        <option value="">None</option>
                        ${projectOptions}
                    </select>
                </div>
                <div class="library-meta-row">
                    <label class="library-meta-label">Idea</label>
                    <select class="library-project-select" id="library-freenote-idea">
                        <option value="">None</option>
                        ${ideaOptions}
                    </select>
                </div>
                <textarea class="library-editor-textarea" id="library-freenote-body" placeholder="Write anything here...">${escHtml(note.body || '')}</textarea>
            </div>
        `;

        document.getElementById('library-back-btn').addEventListener('click', () => saveFreeNoteAndBack());
        document.getElementById('library-freenote-title').addEventListener('input', scheduleFreeNoteSave);
        document.getElementById('library-freenote-body').addEventListener('input', scheduleFreeNoteSave);
        document.getElementById('library-freenote-project').addEventListener('change', scheduleFreeNoteSave);
        document.getElementById('library-freenote-idea').addEventListener('change', scheduleFreeNoteSave);
        document.getElementById('library-freenote-pin').addEventListener('click', toggleFreeNotePin);
    }

    async function toggleFreeNotePin() {
        if (!selectedFreeNote) return;
        selectedFreeNote.pinned = !selectedFreeNote.pinned;
        const pinBtn = document.getElementById('library-freenote-pin');
        if (pinBtn) {
            pinBtn.classList.toggle('pinned', selectedFreeNote.pinned);
            pinBtn.title = selectedFreeNote.pinned ? 'Unpin' : 'Pin to top';
        }
        try {
            await fetch(`/api/data/notes/${selectedFreeNote.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pinned: selectedFreeNote.pinned })
            });
        } catch (e) {
            console.warn('Library: toggle pin failed', e);
            selectedFreeNote.pinned = !selectedFreeNote.pinned;
        }
    }

    function scheduleFreeNoteSave() {
        freeNoteDirty = true; setSaveStatus('Editing...');
        if (freeNoteSaveTimer) clearTimeout(freeNoteSaveTimer);
        freeNoteSaveTimer = setTimeout(() => saveFreeNote(), 1500);
    }

    async function saveFreeNote() {
        if (!selectedFreeNote || !freeNoteDirty) return;
        const titleEl = document.getElementById('library-freenote-title');
        const bodyEl = document.getElementById('library-freenote-body');
        const projectEl = document.getElementById('library-freenote-project');
        const ideaEl = document.getElementById('library-freenote-idea');
        if (!titleEl) return;
        setSaveStatus('Saving...'); freeNoteDirty = false;
        try {
            const fields = {
                title: titleEl.value.trim() || 'Untitled',
                body: bodyEl?.value || '',
                linkedProject: projectEl?.value || '',
                linkedIdeaId: ideaEl?.value || '',
                lastEdited: new Date().toISOString()
            };
            const res = await fetch(`/api/data/notes/${selectedFreeNote.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fields)
            });
            if (!res.ok) throw new Error('Save failed');
            const updated = await res.json();
            const idx = freeNotes.findIndex(n => n.id === selectedFreeNote.id);
            if (idx >= 0) freeNotes[idx] = updated;
            selectedFreeNote = updated;
            setSaveStatus('Saved');
        } catch (e) { setSaveStatus('Save failed'); freeNoteDirty = true; }
    }

    async function saveFreeNoteAndBack() {
        if (freeNoteDirty && selectedFreeNote) await saveFreeNote();
        selectedFreeNote = null;
        showListPage();
        renderFreeNotesList();
    }

    async function handleNewFreeNote() {
        try {
            const res = await fetch('/api/data/notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Untitled',
                    body: '',
                    linkedProject: '',
                    linkedIdeaId: '',
                    pinned: false,
                    lastEdited: new Date().toISOString()
                })
            });
            if (!res.ok) throw new Error('Create failed');
            const note = await res.json();
            freeNotes.push(note);
            selectedFreeNote = note;
            showEditorPage();
            await renderFreeNoteEditor(note);
            const titleInput = document.getElementById('library-freenote-title');
            if (titleInput) { titleInput.focus(); titleInput.select(); }
        } catch (e) {
            console.warn('Library: create free note failed', e);
            alert('Failed to create note. Check connection.');
        }
    }

    async function handleDeleteFreeNote(id) {
        const note = freeNotes.find(n => n.id === id);
        if (!note || !confirm(`Delete "${note.title || 'Untitled'}"?`)) return;
        try {
            const res = await fetch(`/api/data/notes/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Delete failed');
            freeNotes = freeNotes.filter(n => n.id !== id);
            if (selectedFreeNote && selectedFreeNote.id === id) { selectedFreeNote = null; if (currentPage === 'editor') showListPage(); }
            renderFreeNotesList();
        } catch (e) { console.warn('Library: delete free note failed', e); }
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
    // --- SPONSORS (Companies + Video Deals, R2-backed) ---
    // =====================

    async function fetchSponsors() {
        const [compRes, vidRes] = await Promise.all([
            fetch('/api/data/sponsors'),
            fetch('/api/data/sponsorvideos')
        ]);
        const companies = compRes.ok ? await compRes.json() : [];
        const videos = vidRes.ok ? await vidRes.json() : [];
        return { companies, videos };
    }

    function toCAD(amount, currency) {
        const rate = CAD_RATES[currency] || 1;
        return amount * rate;
    }

    function getExpectedIncomeCADInternal() {
        return sponsorVideos
            .filter(v => v.status !== 'paid' && v.status !== 'cancelled' && v.status !== 'invoiced')
            .reduce((sum, v) => sum + toCAD(v.amount || 0, v.currency || 'CAD'), 0);
    }

    function getCompanyName(companyId) {
        const c = sponsorCompanies.find(x => x.id === companyId);
        return c ? (c.nickname || c.name) : 'Unknown';
    }

    const SPONSOR_STATUS_LABELS = {
        pending: 'Pending', active: 'Active', delivered: 'Delivered',
        invoiced: 'Invoiced', paid: 'Paid', cancelled: 'Cancelled'
    };
    const SPONSOR_STATUS_COLORS = {
        pending: '#ff9500', active: '#0984e3', delivered: '#6c5ce7',
        invoiced: '#e67e22', paid: '#27ae60', cancelled: '#999'
    };
    const COMPANY_STATUS_LABELS = { pending: 'Pending', open: 'Open', closed: 'Closed' };
    const COMPANY_STATUS_COLORS = { pending: '#ff9500', open: '#0984e3', closed: '#999' };

    function renderSponsorsTab() {
        const el = document.getElementById('library-sponsors-container');
        if (!el) return;
        if (!sponsorsLoaded) {
            el.innerHTML = '<div class="library-empty">Loading sponsors...</div>';
            fetchSponsors().then(data => {
                sponsorCompanies = data.companies;
                sponsorVideos = data.videos;
                sponsorsLoaded = true;
                renderSponsorsTab();
                updateSponsorsBadge();
                if (typeof updateFinanceDisplay === 'function') updateFinanceDisplay();
            }).catch(() => {
                el.innerHTML = '<div class="library-empty">Could not load sponsors.</div>';
            });
            return;
        }
        // If editing a company or video deal, show the form
        if (editingSponsor) { renderSponsorForm(el); return; }
        if (editingSponsorVideo) { renderSponsorVideoForm(el); return; }
        renderSponsorsContent(el);
    }

    function backgroundRefreshSponsors() {
        if (sponsorsBusy) return;
        fetchSponsors().then(data => {
            if (sponsorsBusy) return;
            sponsorCompanies = data.companies;
            sponsorVideos = data.videos;
            updateSponsorsBadge();
            if (typeof updateFinanceDisplay === 'function') updateFinanceDisplay();
            if (!editingSponsor && !editingSponsorVideo) {
                const el = document.getElementById('library-sponsors-container');
                if (el) renderSponsorsContent(el);
            }
        }).catch(() => {});
    }

    function renderSponsorsContent(el) {
        if (!el) return;

        const totalCAD = getExpectedIncomeCADInternal();
        const activeDeals = sponsorVideos.filter(v => v.status !== 'paid' && v.status !== 'cancelled' && v.status !== 'invoiced');

        const openCompanies = sponsorCompanies.filter(c => (c.companyStatus || 'open') !== 'closed');
        const closedCompanies = sponsorCompanies.filter(c => (c.companyStatus || 'open') === 'closed');
        const finishedVideos = sponsorVideos.filter(v => v.status === 'paid' || v.status === 'cancelled' || v.status === 'invoiced');

        let html = `
            <div class="sponsor-summary-bar">
                Expected: <strong>$${Math.round(totalCAD).toLocaleString()} CAD</strong>
                <span style="color:#888;font-size:12px;margin-left:6px;">(${activeDeals.length} active deal${activeDeals.length !== 1 ? 's' : ''})</span>
            </div>
            <div class="sponsor-sub-tabs">
                <button class="sponsor-sub-tab${sponsorsSubTab === 'companies' ? ' active' : ''}" data-subtab="companies">Companies (${openCompanies.length})</button>
                <button class="sponsor-sub-tab${sponsorsSubTab === 'videos' ? ' active' : ''}" data-subtab="videos">Video Deals (${activeDeals.length})</button>
            </div>
        `;

        if (sponsorsSubTab === 'companies') {
            html += renderCompaniesListHtml();
        } else {
            html += renderVideoDealsListHtml();
        }

        el.innerHTML = html;

        // Sub-tab clicks
        el.querySelectorAll('.sponsor-sub-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                sponsorsSubTab = btn.dataset.subtab;
                renderSponsorsContent(el);
            });
        });

        // Company card clicks
        el.querySelectorAll('.sponsor-company-card').forEach(card => {
            card.addEventListener('click', () => {
                editingSponsor = card.dataset.id;
                renderSponsorsTab();
            });
        });
        el.querySelectorAll('.sponsor-company-delete').forEach(btn => {
            btn.addEventListener('click', e => { e.stopPropagation(); deleteSponsorCompany(btn.dataset.id); });
        });

        // Video deal clicks
        el.querySelectorAll('.sponsor-video-card').forEach(card => {
            card.addEventListener('click', () => {
                editingSponsorVideo = card.dataset.id;
                renderSponsorsTab();
            });
        });
        el.querySelectorAll('.sponsor-video-delete').forEach(btn => {
            btn.addEventListener('click', e => { e.stopPropagation(); deleteSponsorVideo(btn.dataset.id); });
        });
        el.querySelectorAll('.sponsor-video-invoice-btn').forEach(btn => {
            btn.addEventListener('click', e => { e.stopPropagation(); generateInvoice(btn.dataset.id); });
        });
        el.querySelectorAll('.sponsor-video-view-btn').forEach(btn => {
            btn.addEventListener('click', e => { e.stopPropagation(); previewInvoice(btn.dataset.invoiceid); });
        });

        // Collapsible sections
        const closedToggle = el.querySelector('.sponsor-closed-toggle');
        if (closedToggle) {
            closedToggle.addEventListener('click', () => {
                const section = el.querySelector('.sponsor-closed-section');
                if (section) {
                    const showing = section.style.display !== 'none';
                    section.style.display = showing ? 'none' : '';
                    const count = closedToggle.textContent.match(/\d+/)?.[0] || '';
                    closedToggle.innerHTML = `Closed (${count}) ${showing ? '&#9662;' : '&#9652;'}`;
                }
            });
        }
        const finishedToggle = el.querySelector('.sponsor-finished-toggle');
        if (finishedToggle) {
            finishedToggle.addEventListener('click', () => {
                const section = el.querySelector('.sponsor-finished-section');
                if (section) {
                    const showing = section.style.display !== 'none';
                    section.style.display = showing ? 'none' : '';
                    const count = finishedToggle.textContent.match(/\d+/)?.[0] || '';
                    finishedToggle.innerHTML = `Closed (${count}) ${showing ? '&#9662;' : '&#9652;'}`;
                }
            });
        }
    }

    function renderCompanyCardHtml(c) {
        const dealCount = sponsorVideos.filter(v => v.companyId === c.id).length;
        const totalAmount = sponsorVideos.filter(v => v.companyId === c.id).reduce((s, v) => s + toCAD(v.amount || 0, v.currency || 'CAD'), 0);
        const addrPreview = (c.address || '').split('\n')[0];
        const cs = c.companyStatus || 'open';
        const csColor = COMPANY_STATUS_COLORS[cs] || '#999';
        const csLabel = COMPANY_STATUS_LABELS[cs] || cs;
        return `
            <div class="sponsor-company-card" data-id="${escAttr(c.id)}">
                <div class="sponsor-company-info">
                    <div class="sponsor-company-name">${escHtml(c.nickname || c.name)} <span class="sponsor-status-badge" style="background:${csColor}20;color:${csColor};font-size:10px;margin-left:4px">${csLabel}</span></div>
                    ${addrPreview ? `<div class="sponsor-company-meta"><span>${escHtml(addrPreview)}</span></div>` : ''}
                    <div class="sponsor-company-stats">
                        <span>${dealCount} deal${dealCount !== 1 ? 's' : ''}</span>
                        ${totalAmount > 0 ? `<span class="sponsor-company-total">$${Math.round(totalAmount).toLocaleString()} CAD</span>` : ''}
                    </div>
                </div>
                <button class="sponsor-company-delete" data-id="${escAttr(c.id)}" title="Delete">&times;</button>
            </div>`;
    }

    function renderCompaniesListHtml() {
        if (sponsorCompanies.length === 0) {
            return '<div class="library-empty">No sponsor companies yet. Tap + to add one.</div>';
        }
        const pending = sponsorCompanies.filter(c => (c.companyStatus || 'open') === 'pending');
        const open = sponsorCompanies.filter(c => (c.companyStatus || 'open') === 'open');
        const closed = sponsorCompanies.filter(c => (c.companyStatus || 'open') === 'closed');

        let html = '';
        if (pending.length > 0) {
            html += '<div class="library-todo-section-header">Pending</div>';
            html += pending.map(renderCompanyCardHtml).join('');
        }
        if (open.length > 0) {
            html += '<div class="library-todo-section-header">Open</div>';
            html += open.map(renderCompanyCardHtml).join('');
        }
        if (closed.length > 0) {
            html += `<div class="library-todo-section-header sponsor-closed-toggle" style="cursor:pointer">Closed (${closed.length}) &#9662;</div>`;
            html += `<div class="sponsor-closed-section" style="display:none">${closed.map(renderCompanyCardHtml).join('')}</div>`;
        }
        return html;
    }

    function renderVideoCardHtml(v) {
        const company = getCompanyName(v.companyId);
        const color = SPONSOR_STATUS_COLORS[v.status] || '#999';
        const label = SPONSOR_STATUS_LABELS[v.status] || v.status;
        const cadAmt = toCAD(v.amount || 0, v.currency || 'CAD');
        const cadNote = (v.currency && v.currency !== 'CAD' && v.amount) ? ` (~$${Math.round(cadAmt).toLocaleString()} CAD)` : '';
        const hasInvoice = !!v.invoiceId;
        return `
            <div class="sponsor-video-card" data-id="${escAttr(v.id)}">
                <div class="sponsor-video-info">
                    <div class="sponsor-video-title">${escHtml(v.title || 'Untitled Deal')}</div>
                    <div class="sponsor-video-company">${escHtml(company)}</div>
                    <div class="sponsor-video-details">
                        ${v.amount ? `<span class="sponsor-video-amount">$${v.amount.toLocaleString(undefined, {minimumFractionDigits: 2})} ${escHtml(v.currency || 'CAD')}${cadNote}</span>` : ''}
                    </div>
                </div>
                <div class="sponsor-video-actions">
                    <span class="sponsor-status-badge" style="background:${color}20;color:${color}">${label}</span>
                    ${hasInvoice
                        ? `<button class="sponsor-video-view-btn" data-invoiceid="${escAttr(v.invoiceId)}" title="View Invoice">&#128196;</button>`
                        : (v.status !== 'paid' && v.status !== 'cancelled' && v.status !== 'invoiced'
                            ? `<button class="sponsor-video-invoice-btn" data-id="${escAttr(v.id)}" title="Create Invoice">&#9993;</button>`
                            : '')}
                    <button class="sponsor-video-delete" data-id="${escAttr(v.id)}" title="Delete">&times;</button>
                </div>
            </div>`;
    }

    function sortVideos(list) {
        const order = { pending: 0, active: 1, delivered: 2, invoiced: 3, paid: 4, cancelled: 5 };
        return [...list].sort((a, b) => {
            const diff = (order[a.status] || 0) - (order[b.status] || 0);
            if (diff !== 0) return diff;
            return (b.createdAt || '').localeCompare(a.createdAt || '');
        });
    }

    function renderVideoDealsListHtml() {
        if (sponsorVideos.length === 0) {
            return '<div class="library-empty">No video deals yet. Tap + to add one.</div>';
        }
        const active = sortVideos(sponsorVideos.filter(v => v.status !== 'paid' && v.status !== 'cancelled' && v.status !== 'invoiced'));
        const finished = sortVideos(sponsorVideos.filter(v => v.status === 'paid' || v.status === 'cancelled' || v.status === 'invoiced'));

        let html = '';
        if (active.length > 0) {
            html += active.map(renderVideoCardHtml).join('');
        } else {
            html += '<div class="library-empty">No active deals.</div>';
        }
        if (finished.length > 0) {
            html += `<div class="library-todo-section-header sponsor-finished-toggle" style="cursor:pointer">Closed (${finished.length}) &#9662;</div>`;
            html += `<div class="sponsor-finished-section" style="display:none">${finished.map(renderVideoCardHtml).join('')}</div>`;
        }
        return html;
    }

    // --- Company Form ---
    function renderSponsorForm(el) {
        const isNew = editingSponsor === 'new';
        const c = isNew ? {} : sponsorCompanies.find(x => x.id === editingSponsor) || {};
        const companyStatuses = Object.keys(COMPANY_STATUS_LABELS);
        const curStatus = c.companyStatus || 'open';
        el.innerHTML = `
            <div class="sponsor-form-header">
                <button class="sponsor-form-back" id="sponsor-form-back">&#8592; Back</button>
                <span class="sponsor-form-title">${isNew ? 'New Company' : 'Edit Company'}</span>
            </div>
            <div class="sponsor-form-body">
                <div class="sponsor-form-row">
                    <div class="sponsor-form-col" style="flex:2">
                        <label class="sponsor-label">Company Name *</label>
                        <input class="sponsor-input" id="sp-name" value="${escAttr(c.name || '')}" placeholder="Full company name (used on invoices)" />
                    </div>
                    <div class="sponsor-form-col" style="flex:1">
                        <label class="sponsor-label">Status</label>
                        <select class="sponsor-select" id="sp-status">
                            ${companyStatuses.map(s => `<option value="${s}"${s === curStatus ? ' selected' : ''}>${COMPANY_STATUS_LABELS[s]}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <label class="sponsor-label">Nickname</label>
                <input class="sponsor-input" id="sp-nickname" value="${escAttr(c.nickname || '')}" placeholder="Short name shown in list (defaults to company name)" />
                <label class="sponsor-label">Address</label>
                <textarea class="sponsor-textarea" id="sp-address" placeholder="Full address...">${escHtml(c.address || '')}</textarea>
                <label class="sponsor-label">Notes</label>
                <textarea class="sponsor-textarea" id="sp-notes" placeholder="Campaign briefs, contact info, or anything else...">${escHtml(c.notes || '')}</textarea>
                <button class="sponsor-save-btn" id="sp-save-btn">${isNew ? 'Add Company' : 'Save Changes'}</button>
                ${!isNew ? `<div class="sponsor-form-section-header">Video Deals (${sponsorVideos.filter(v => v.companyId === c.id).length})</div>` : ''}
                ${!isNew ? sponsorVideos.filter(v => v.companyId === c.id).map(v => {
                    const color = SPONSOR_STATUS_COLORS[v.status] || '#999';
                    const label = SPONSOR_STATUS_LABELS[v.status] || v.status;
                    return `<div class="sponsor-linked-deal" data-vid="${escAttr(v.id)}">
                        <span class="sponsor-linked-deal-title">${escHtml(v.title || 'Untitled')}</span>
                        <span class="sponsor-status-badge" style="background:${color}20;color:${color}">${label}</span>
                        ${v.amount ? `<span class="sponsor-linked-deal-amount">$${v.amount.toLocaleString(undefined, {minimumFractionDigits: 2})}</span>` : ''}
                    </div>`;
                }).join('') : ''}
            </div>
        `;
        document.getElementById('sponsor-form-back').addEventListener('click', () => { editingSponsor = null; renderSponsorsTab(); });
        document.getElementById('sp-save-btn').addEventListener('click', saveSponsorCompany);
        // Click linked deals to edit them
        el.querySelectorAll('.sponsor-linked-deal').forEach(d => {
            d.addEventListener('click', () => { editingSponsor = null; editingSponsorVideo = d.dataset.vid; renderSponsorsTab(); });
        });
    }

    async function saveSponsorCompany() {
        const name = (document.getElementById('sp-name')?.value || '').trim();
        if (!name) { alert('Company name is required.'); return; }
        const nickname = (document.getElementById('sp-nickname')?.value || '').trim();
        const fields = {
            name,
            nickname: nickname || '',
            companyStatus: document.getElementById('sp-status')?.value || 'open',
            address: document.getElementById('sp-address')?.value.trim() || '',
            notes: document.getElementById('sp-notes')?.value.trim() || ''
        };
        sponsorsBusy = true;
        try {
            if (editingSponsor === 'new') {
                const res = await fetch('/api/data/sponsors', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields)
                });
                if (!res.ok) throw new Error('Failed');
                const created = await res.json();
                sponsorCompanies.push(created);
            } else {
                const res = await fetch(`/api/data/sponsors/${editingSponsor}`, {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields)
                });
                if (!res.ok) throw new Error('Failed');
                const updated = await res.json();
                const idx = sponsorCompanies.findIndex(c => c.id === editingSponsor);
                if (idx >= 0) sponsorCompanies[idx] = updated;
            }
            editingSponsor = null;
            renderSponsorsTab();
            updateSponsorsBadge();
        } catch (e) {
            console.warn('Sponsors: save company failed', e);
            alert('Failed to save company.');
        } finally {
            sponsorsBusy = false;
        }
    }

    async function deleteSponsorCompany(id) {
        if (!confirm('Delete this company and all its video deals?')) return;
        sponsorsBusy = true;
        try {
            // Delete linked video deals first
            const linked = sponsorVideos.filter(v => v.companyId === id);
            for (const v of linked) {
                await fetch(`/api/data/sponsorvideos/${v.id}`, { method: 'DELETE' });
            }
            const res = await fetch(`/api/data/sponsors/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed');
            sponsorCompanies = sponsorCompanies.filter(c => c.id !== id);
            sponsorVideos = sponsorVideos.filter(v => v.companyId !== id);
            renderSponsorsTab();
            updateSponsorsBadge();
            if (typeof updateFinanceDisplay === 'function') updateFinanceDisplay();
        } catch (e) {
            console.warn('Sponsors: delete company failed', e);
            alert('Failed to delete company.');
        } finally {
            sponsorsBusy = false;
        }
    }

    // --- Video Deal Form ---
    function renderSponsorVideoForm(el) {
        const isNew = editingSponsorVideo === 'new';
        const v = isNew ? {} : sponsorVideos.find(x => x.id === editingSponsorVideo) || {};
        const currencies = Object.keys(CAD_RATES);
        const statuses = Object.keys(SPONSOR_STATUS_LABELS);
        const hasInvoice = !!v.invoiceId;
        el.innerHTML = `
            <div class="sponsor-form-header">
                <button class="sponsor-form-back" id="sponsor-form-back">&#8592; Back</button>
                <span class="sponsor-form-title">${isNew ? 'New Video Deal' : 'Edit Video Deal'}</span>
            </div>
            <div class="sponsor-form-body">
                <label class="sponsor-label">Video Title *</label>
                <input class="sponsor-input" id="sv-title" value="${escAttr(v.title || '')}" placeholder="Video title / campaign" />
                <label class="sponsor-label">Company *</label>
                <select class="sponsor-select" id="sv-company">
                    <option value="">— Select company —</option>
                    ${sponsorCompanies.map(c => `<option value="${escAttr(c.id)}"${c.id === v.companyId ? ' selected' : ''}>${escHtml(c.nickname || c.name)}</option>`).join('')}
                </select>
                <div class="sponsor-form-row">
                    <div class="sponsor-form-col">
                        <label class="sponsor-label">Amount *</label>
                        <input class="sponsor-input" id="sv-amount" type="number" step="0.01" min="0" value="${v.amount || ''}" placeholder="0.00" />
                    </div>
                    <div class="sponsor-form-col">
                        <label class="sponsor-label">Currency</label>
                        <select class="sponsor-select" id="sv-currency">
                            ${currencies.map(c => `<option value="${c}"${c === (v.currency || 'CAD') ? ' selected' : ''}>${c}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <label class="sponsor-label">Status</label>
                <select class="sponsor-select" id="sv-status">
                    ${statuses.map(s => `<option value="${s}"${s === (v.status || 'pending') ? ' selected' : ''}>${SPONSOR_STATUS_LABELS[s]}</option>`).join('')}
                </select>
                <label class="sponsor-label">Deliverables</label>
                <textarea class="sponsor-textarea" id="sv-deliverables" placeholder="What needs to be delivered...">${escHtml(v.deliverables || '')}</textarea>
                <label class="sponsor-label">Notes</label>
                <textarea class="sponsor-textarea" id="sv-notes" placeholder="Additional notes...">${escHtml(v.notes || '')}</textarea>
                <button class="sponsor-save-btn" id="sv-save-btn">${isNew ? 'Add Deal' : 'Save Changes'}</button>
                ${!isNew && !hasInvoice ? `<button class="sponsor-invoice-btn" id="sv-gen-invoice">Create Invoice</button>` : ''}
                ${hasInvoice ? `<div class="sponsor-invoice-actions-row">
                    <button class="sponsor-view-btn" id="sv-view-invoice" data-invoiceid="${escAttr(v.invoiceId)}">View Invoice</button>
                    <button class="sponsor-download-btn" id="sv-dl-invoice" data-invoiceid="${escAttr(v.invoiceId)}">Save as PDF</button>
                    <button class="sponsor-delete-invoice-btn" id="sv-del-invoice" data-invoiceid="${escAttr(v.invoiceId)}">Delete Invoice</button>
                </div>` : ''}
            </div>
        `;
        document.getElementById('sponsor-form-back').addEventListener('click', () => { editingSponsorVideo = null; renderSponsorsTab(); });
        document.getElementById('sv-save-btn').addEventListener('click', saveSponsorVideo);
        const genBtn = document.getElementById('sv-gen-invoice');
        if (genBtn) genBtn.addEventListener('click', () => generateInvoice(editingSponsorVideo));
        const viewBtn = document.getElementById('sv-view-invoice');
        if (viewBtn) viewBtn.addEventListener('click', () => previewInvoice(viewBtn.dataset.invoiceid));
        const dlBtn = document.getElementById('sv-dl-invoice');
        if (dlBtn) dlBtn.addEventListener('click', () => downloadInvoiceAsPdf(dlBtn.dataset.invoiceid));
        const delInvBtn = document.getElementById('sv-del-invoice');
        if (delInvBtn) delInvBtn.addEventListener('click', () => deleteInvoice(delInvBtn.dataset.invoiceid, editingSponsorVideo));
    }

    async function saveSponsorVideo() {
        const title = (document.getElementById('sv-title')?.value || '').trim();
        const companyId = document.getElementById('sv-company')?.value || '';
        const amount = parseFloat(document.getElementById('sv-amount')?.value) || 0;
        if (!title || !companyId) { alert('Title and company are required.'); return; }
        const fields = {
            title, companyId, amount,
            currency: document.getElementById('sv-currency')?.value || 'CAD',
            status: document.getElementById('sv-status')?.value || 'pending',
            deliverables: document.getElementById('sv-deliverables')?.value.trim() || '',
            notes: document.getElementById('sv-notes')?.value.trim() || ''
        };
        sponsorsBusy = true;
        try {
            if (editingSponsorVideo === 'new') {
                const res = await fetch('/api/data/sponsorvideos', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields)
                });
                if (!res.ok) throw new Error('Failed');
                const created = await res.json();
                sponsorVideos.push(created);
            } else {
                const res = await fetch(`/api/data/sponsorvideos/${editingSponsorVideo}`, {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields)
                });
                if (!res.ok) throw new Error('Failed');
                const updated = await res.json();
                const idx = sponsorVideos.findIndex(v => v.id === editingSponsorVideo);
                if (idx >= 0) sponsorVideos[idx] = updated;
            }
            editingSponsorVideo = null;
            renderSponsorsTab();
            updateSponsorsBadge();
            if (typeof updateFinanceDisplay === 'function') updateFinanceDisplay();
        } catch (e) {
            console.warn('Sponsors: save video deal failed', e);
            alert('Failed to save video deal.');
        } finally {
            sponsorsBusy = false;
        }
    }

    async function deleteSponsorVideo(id) {
        if (!confirm('Delete this video deal?')) return;
        sponsorsBusy = true;
        try {
            const res = await fetch(`/api/data/sponsorvideos/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed');
            sponsorVideos = sponsorVideos.filter(v => v.id !== id);
            renderSponsorsTab();
            updateSponsorsBadge();
            if (typeof updateFinanceDisplay === 'function') updateFinanceDisplay();
        } catch (e) {
            console.warn('Sponsors: delete video deal failed', e);
            alert('Failed to delete video deal.');
        } finally {
            sponsorsBusy = false;
        }
    }

    async function generateInvoice(videoId) {
        const v = sponsorVideos.find(x => x.id === videoId);
        if (!v) return;
        if (!confirm(`Generate invoice for "${v.title || 'this deal'}"?`)) return;
        sponsorsBusy = true;
        try {
            const res = await fetch('/api/invoices/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sponsorVideoId: videoId })
            });
            if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'Failed'); }
            const data = await res.json();
            // Update local video with invoiceId and persist status change
            v.invoiceId = data.invoice.id;
            if (v.status === 'pending' || v.status === 'active' || v.status === 'delivered') v.status = 'invoiced';
            await fetch(`/api/data/sponsorvideos/${videoId}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ invoiceId: v.invoiceId, status: v.status })
            });
            renderSponsorsTab();
            updateSponsorsBadge();
        } catch (e) {
            console.warn('Sponsors: generate invoice failed', e);
            alert('Failed to generate invoice: ' + e.message);
        } finally {
            sponsorsBusy = false;
        }
    }

    function previewInvoice(invoiceId) {
        if (!invoiceId) return;
        // Create popup overlay with iframe
        const overlay = document.createElement('div');
        overlay.className = 'sponsor-invoice-overlay';
        overlay.innerHTML = `
            <div class="sponsor-invoice-popup">
                <div class="sponsor-invoice-popup-header">
                    <span>Invoice Preview</span>
                    <div class="sponsor-invoice-popup-actions">
                        <button class="sponsor-invoice-popup-pdf" title="Save as PDF">Save PDF</button>
                        <button class="sponsor-invoice-popup-close" title="Close">&times;</button>
                    </div>
                </div>
                <iframe class="sponsor-invoice-iframe" src="/api/invoices/${encodeURIComponent(invoiceId)}/download"></iframe>
            </div>
        `;
        (container || document.body).appendChild(overlay);
        overlay.querySelector('.sponsor-invoice-popup-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        overlay.querySelector('.sponsor-invoice-popup-pdf').addEventListener('click', () => {
            downloadInvoiceAsPdf(invoiceId);
        });
    }

    async function downloadInvoiceAsPdf(invoiceId) {
        if (!invoiceId) return;
        try {
            const res = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}/pdf`);
            const blob = await res.blob();
            const fileName = (res.headers.get('Content-Disposition') || '').match(/filename="(.+)"/)?.[1] || 'invoice.pdf';
            const file = new File([blob], fileName, { type: 'application/pdf' });
            // iOS: native share sheet (Save to Files, AirDrop, etc.)
            if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: fileName });
            } else {
                // Desktop: blob URL + anchor download
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }
        } catch (e) {
            console.error('PDF download error:', e);
        }
    }

    async function deleteInvoice(invoiceId, videoId) {
        if (!invoiceId) return;
        if (!confirm('Delete this invoice? This cannot be undone.')) return;
        sponsorsBusy = true;
        try {
            const res = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed');
            // Clear invoiceId and reset status back to active
            if (videoId) {
                const v = sponsorVideos.find(x => x.id === videoId);
                if (v) {
                    v.invoiceId = null;
                    if (v.status === 'invoiced') v.status = 'active';
                    await fetch(`/api/data/sponsorvideos/${videoId}`, {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ invoiceId: null, status: v.status })
                    }).catch(() => {});
                }
            }
            renderSponsorsTab();
        } catch (e) {
            console.warn('Sponsors: delete invoice failed', e);
            alert('Failed to delete invoice.');
        } finally {
            sponsorsBusy = false;
        }
    }

    function updateSponsorsBadge() {
        const badge = document.getElementById('sponsors-badge');
        if (!badge) return;
        const count = sponsorVideos.filter(v => v.status !== 'paid' && v.status !== 'cancelled' && v.status !== 'invoiced').length;
        badge.textContent = count;
        badge.style.display = count > 0 ? '' : 'none';
    }

    // =====================
    // --- IDEA MAP ---
    // =====================
    const IDEAMAP_STATUS_COLORS = {
        idea: '#4a9eff',
        incubator: '#e8a020',
        'in-progress': '#e67e22',
        converted: '#2ecc71',
        posted: '#2ecc71',
        hook: '#9b59b6'
    };

    const IDEAMAP_CLUSTERS = {
        'Magnetism': ['magnetism', 'magnet'],
        'Flight': ['flight', 'drones'],
        'Bulletproof / Armor': ['bulletproof', 'helmet'],
        'Exoskeleton / Strength': ['exoskeleton', 'strength'],
        'Jarvis / AI': ['jarvis', 'ai'],
        'Superhero Gadgets': ['superhero', 'gadget'],
        'Stunts / Survival': ['stunt', 'survival'],
        'Chemistry / Science': ['chemistry', 'science', 'materials', 'food'],
        '3D Printing': ['3d-printing'],
        'Jet Engine': ['jet-engine'],
        'Hook Ideas': ['hook'],
        'Engineering / Fun': ['engineering', 'fun', 'gaming'],
        'Wearables': ['wearable', 'fireproof', 'protection', 'waterproof'],
        'Other': []
    };

    let ideaMapState = {
        ideas: [],
        positions: {},  // id → {x, y}
        edges: [],      // [{from, to}]
        colors: {},     // id → color override
        zoom: 1,
        panX: 0, panY: 0,
        connectMode: false,
        connectFrom: null,
        filterStatus: 'all',
        filterTag: 'all',
        dragging: null,
        dragOffsetX: 0, dragOffsetY: 0,
        loaded: false
    };

    function ideaMapGetCluster(idea) {
        let tags = [];
        if (idea.tags) {
            try { tags = JSON.parse(idea.tags); } catch(e) { tags = []; }
        }
        for (const [cluster, keywords] of Object.entries(IDEAMAP_CLUSTERS)) {
            if (cluster === 'Other') continue;
            if (keywords.some(k => tags.includes(k))) return cluster;
        }
        return 'Other';
    }

    function ideaMapGetTags(idea) {
        if (!idea.tags) return [];
        try { return JSON.parse(idea.tags); } catch(e) { return []; }
    }

    function ideaMapInitPositions(ideas) {
        const saved = localStorage.getItem('gym-idea-map-positions');
        let savedPos = {};
        if (saved) { try { savedPos = JSON.parse(saved); } catch(e) {} }

        // Group ideas by cluster
        const clusters = {};
        for (const idea of ideas) {
            const c = ideaMapGetCluster(idea);
            if (!clusters[c]) clusters[c] = [];
            clusters[c].push(idea);
        }

        const clusterNames = Object.keys(clusters);
        const cols = Math.ceil(Math.sqrt(clusterNames.length));
        const clusterW = 400;
        const clusterH = 280;
        const nodeW = 180;
        const nodeH = 36;
        const padX = 40;
        const padY = 50;

        const positions = {};
        clusterNames.forEach((cName, ci) => {
            const col = ci % cols;
            const row = Math.floor(ci / cols);
            const cx = col * (clusterW + padX) + 60;
            const cy = row * (clusterH + padY) + 60;

            const nodesInCluster = clusters[cName];
            const nodeCols = Math.min(nodesInCluster.length, 2);
            nodesInCluster.forEach((idea, ni) => {
                if (savedPos[idea.id]) {
                    positions[idea.id] = savedPos[idea.id];
                } else {
                    const ncol = ni % nodeCols;
                    const nrow = Math.floor(ni / nodeCols);
                    positions[idea.id] = {
                        x: cx + ncol * (nodeW + 12),
                        y: cy + 30 + nrow * (nodeH + 8)
                    };
                }
            });
        });
        return positions;
    }

    function ideaMapSavePositions() {
        localStorage.setItem('gym-idea-map-positions', JSON.stringify(ideaMapState.positions));
    }

    function ideaMapSaveEdges() {
        localStorage.setItem('gym-idea-map-edges', JSON.stringify(ideaMapState.edges));
    }

    function ideaMapSaveColors() {
        localStorage.setItem('gym-idea-map-colors', JSON.stringify(ideaMapState.colors));
    }

    function ideaMapLoadEdges() {
        const saved = localStorage.getItem('gym-idea-map-edges');
        if (saved) { try { return JSON.parse(saved); } catch(e) {} }
        return [];
    }

    function ideaMapLoadColors() {
        const saved = localStorage.getItem('gym-idea-map-colors');
        if (saved) { try { return JSON.parse(saved); } catch(e) {} }
        return {};
    }

    function ideaMapGetColor(idea) {
        if (ideaMapState.colors[idea.id]) return ideaMapState.colors[idea.id];
        const status = idea.status || idea.type || 'idea';
        return IDEAMAP_STATUS_COLORS[status] || IDEAMAP_STATUS_COLORS.idea;
    }

    function ideaMapFilteredIdeas() {
        let ideas = ideaMapState.ideas;
        if (ideaMapState.filterStatus !== 'all') {
            ideas = ideas.filter(i => (i.status || i.type || 'idea') === ideaMapState.filterStatus);
        }
        if (ideaMapState.filterTag !== 'all') {
            ideas = ideas.filter(i => ideaMapGetTags(i).includes(ideaMapState.filterTag));
        }
        return ideas;
    }

    function ideaMapAllTags() {
        const tagSet = new Set();
        ideaMapState.ideas.forEach(i => ideaMapGetTags(i).forEach(t => tagSet.add(t)));
        return Array.from(tagSet).sort();
    }

    async function renderIdeaMap() {
        const el = document.getElementById('library-ideamap-container');
        if (!el) return;

        if (!ideaMapState.loaded) {
            el.innerHTML = '<div class="library-empty">Loading ideas...</div>';
            await NotesService.sync(true).catch(() => {});
            ideaMapState.ideas = NotesService.getAll().filter(n => n.type !== 'todo');
            ideaMapState.positions = ideaMapInitPositions(ideaMapState.ideas);
            ideaMapState.edges = ideaMapLoadEdges();
            ideaMapState.colors = ideaMapLoadColors();
            ideaMapState.loaded = true;
        }

        ideaMapRender(el);
    }

    function ideaMapRender(el) {
        const ideas = ideaMapFilteredIdeas();
        const allTags = ideaMapAllTags();
        const nodeW = 180;
        const nodeH = 36;

        // Build cluster labels
        const clusters = {};
        for (const idea of ideas) {
            const c = ideaMapGetCluster(idea);
            if (!clusters[c]) clusters[c] = [];
            clusters[c].push(idea);
        }

        // Compute SVG canvas bounds
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const idea of ideas) {
            const pos = ideaMapState.positions[idea.id];
            if (!pos) continue;
            if (pos.x < minX) minX = pos.x;
            if (pos.y < minY) minY = pos.y;
            if (pos.x + nodeW > maxX) maxX = pos.x + nodeW;
            if (pos.y + nodeH > maxY) maxY = pos.y + nodeH;
        }
        const svgW = Math.max(maxX + 200, 1400);
        const svgH = Math.max(maxY + 100, 800);

        // Toolbar
        let html = `<div class="ideamap-toolbar">
            <select class="ideamap-filter" id="ideamap-filter-status">
                <option value="all"${ideaMapState.filterStatus === 'all' ? ' selected' : ''}>All Status</option>
                <option value="idea"${ideaMapState.filterStatus === 'idea' ? ' selected' : ''}>Ideas</option>
                <option value="incubator"${ideaMapState.filterStatus === 'incubator' ? ' selected' : ''}>Incubator</option>
                <option value="converted"${ideaMapState.filterStatus === 'converted' ? ' selected' : ''}>Converted</option>
                <option value="hook"${ideaMapState.filterStatus === 'hook' ? ' selected' : ''}>Hook</option>
            </select>
            <select class="ideamap-filter" id="ideamap-filter-tag">
                <option value="all">All Tags</option>
                ${allTags.map(t => `<option value="${escAttr(t)}"${ideaMapState.filterTag === t ? ' selected' : ''}>${escHtml(t)}</option>`).join('')}
            </select>
            <button class="ideamap-btn ${ideaMapState.connectMode ? 'active' : ''}" id="ideamap-connect-btn">Connect</button>
            <button class="ideamap-btn" id="ideamap-reset-btn">Reset Layout</button>
            <button class="ideamap-btn" id="ideamap-zoom-in">+</button>
            <button class="ideamap-btn" id="ideamap-zoom-out">-</button>
            <span class="ideamap-zoom-label">${Math.round(ideaMapState.zoom * 100)}%</span>
        </div>`;

        // SVG container
        html += `<div class="ideamap-svg-wrap" id="ideamap-svg-wrap">
            <svg id="ideamap-svg" width="${svgW}" height="${svgH}"
                 style="transform: scale(${ideaMapState.zoom}) translate(${ideaMapState.panX}px, ${ideaMapState.panY}px); transform-origin: 0 0;">`;

        // Cluster labels (background)
        for (const [cName, cIdeas] of Object.entries(clusters)) {
            if (cIdeas.length === 0) continue;
            let cMinX = Infinity, cMinY = Infinity, cMaxX = -Infinity, cMaxY = -Infinity;
            for (const idea of cIdeas) {
                const pos = ideaMapState.positions[idea.id];
                if (!pos) continue;
                if (pos.x < cMinX) cMinX = pos.x;
                if (pos.y < cMinY) cMinY = pos.y;
                if (pos.x + nodeW > cMaxX) cMaxX = pos.x + nodeW;
                if (pos.y + nodeH > cMaxY) cMaxY = pos.y + nodeH;
            }
            const pad = 16;
            html += `<rect x="${cMinX - pad}" y="${cMinY - 28}" width="${cMaxX - cMinX + pad * 2}" height="${cMaxY - cMinY + 28 + pad}"
                     rx="12" fill="rgba(0,0,0,0.03)" stroke="rgba(0,0,0,0.08)" stroke-width="1"/>`;
            html += `<text x="${cMinX - pad + 8}" y="${cMinY - 10}" font-size="12" font-weight="700" fill="rgba(0,0,0,0.35)"
                     font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">${escHtml(cName)}</text>`;
        }

        // Edges
        for (const edge of ideaMapState.edges) {
            const fromPos = ideaMapState.positions[edge.from];
            const toPos = ideaMapState.positions[edge.to];
            if (!fromPos || !toPos) continue;
            // Check if both nodes are in the filtered set
            const fromVisible = ideas.find(i => i.id === edge.from);
            const toVisible = ideas.find(i => i.id === edge.to);
            if (!fromVisible || !toVisible) continue;
            const x1 = fromPos.x + nodeW / 2, y1 = fromPos.y + nodeH / 2;
            const x2 = toPos.x + nodeW / 2, y2 = toPos.y + nodeH / 2;
            html += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(0,0,0,0.2)" stroke-width="2" stroke-dasharray="6 3"/>`;
        }

        // Nodes
        for (const idea of ideas) {
            const pos = ideaMapState.positions[idea.id];
            if (!pos) continue;
            const color = ideaMapGetColor(idea);
            const isConnectFrom = ideaMapState.connectFrom === idea.id;
            const label = idea.name.length > 24 ? idea.name.slice(0, 22) + '...' : idea.name;
            html += `<g class="ideamap-node" data-id="${idea.id}" style="cursor:${ideaMapState.connectMode ? 'crosshair' : 'grab'}">
                <rect x="${pos.x}" y="${pos.y}" width="${nodeW}" height="${nodeH}" rx="8"
                      fill="${color}" stroke="${isConnectFrom ? '#fff' : 'rgba(0,0,0,0.15)'}" stroke-width="${isConnectFrom ? 3 : 1}"
                      filter="url(#ideamap-shadow)"/>
                <text x="${pos.x + nodeW / 2}" y="${pos.y + nodeH / 2 + 5}" text-anchor="middle"
                      font-size="12" font-weight="600" fill="#fff"
                      font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"
                      pointer-events="none">${escHtml(label)}</text>
            </g>`;
        }

        // Shadow filter
        html += `<defs><filter id="ideamap-shadow" x="-4" y="-2" width="${nodeW + 8}" height="${nodeH + 8}">
            <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="rgba(0,0,0,0.15)"/>
        </filter></defs>`;

        html += `</svg></div>`;

        // Popover (hidden by default)
        html += `<div class="ideamap-popover" id="ideamap-popover" style="display:none;"></div>`;

        el.innerHTML = html;

        // Event listeners
        ideaMapBindEvents(el, ideas);
    }

    function ideaMapBindEvents(el, ideas) {
        const svg = el.querySelector('#ideamap-svg');
        const wrap = el.querySelector('#ideamap-svg-wrap');
        if (!svg || !wrap) return;

        // Filter dropdowns
        const statusFilter = el.querySelector('#ideamap-filter-status');
        const tagFilter = el.querySelector('#ideamap-filter-tag');
        if (statusFilter) statusFilter.addEventListener('change', () => {
            ideaMapState.filterStatus = statusFilter.value;
            ideaMapRender(el);
        });
        if (tagFilter) tagFilter.addEventListener('change', () => {
            ideaMapState.filterTag = tagFilter.value;
            ideaMapRender(el);
        });

        // Buttons
        el.querySelector('#ideamap-connect-btn')?.addEventListener('click', () => {
            ideaMapState.connectMode = !ideaMapState.connectMode;
            ideaMapState.connectFrom = null;
            ideaMapRender(el);
        });
        el.querySelector('#ideamap-reset-btn')?.addEventListener('click', () => {
            localStorage.removeItem('gym-idea-map-positions');
            ideaMapState.positions = ideaMapInitPositions(ideaMapState.ideas);
            ideaMapState.zoom = 1;
            ideaMapState.panX = 0;
            ideaMapState.panY = 0;
            ideaMapRender(el);
        });
        el.querySelector('#ideamap-zoom-in')?.addEventListener('click', () => {
            ideaMapState.zoom = Math.min(ideaMapState.zoom + 0.15, 3);
            ideaMapRender(el);
        });
        el.querySelector('#ideamap-zoom-out')?.addEventListener('click', () => {
            ideaMapState.zoom = Math.max(ideaMapState.zoom - 0.15, 0.3);
            ideaMapRender(el);
        });

        // Node interactions (event delegation on SVG)
        let dragNode = null;
        let dragStartX = 0, dragStartY = 0, dragNodeStartX = 0, dragNodeStartY = 0;
        let didDrag = false;
        let lastTap = 0;

        function getNodeFromEvent(e) {
            let target = e.target;
            while (target && target !== svg) {
                if (target.classList && target.classList.contains('ideamap-node')) return target;
                target = target.parentElement;
            }
            return null;
        }

        function svgCoords(e) {
            const pt = e.touches ? e.touches[0] : e;
            return { x: pt.clientX, y: pt.clientY };
        }

        function onPointerDown(e) {
            const node = getNodeFromEvent(e);
            if (!node) return;
            const id = node.dataset.id;
            const coords = svgCoords(e);

            // Connect mode
            if (ideaMapState.connectMode) {
                if (!ideaMapState.connectFrom) {
                    ideaMapState.connectFrom = id;
                    ideaMapRender(el);
                } else if (ideaMapState.connectFrom !== id) {
                    // Check for duplicate
                    const exists = ideaMapState.edges.some(ed =>
                        (ed.from === ideaMapState.connectFrom && ed.to === id) ||
                        (ed.from === id && ed.to === ideaMapState.connectFrom));
                    if (!exists) {
                        ideaMapState.edges.push({ from: ideaMapState.connectFrom, to: id });
                        ideaMapSaveEdges();
                    }
                    ideaMapState.connectFrom = null;
                    ideaMapRender(el);
                }
                e.preventDefault();
                return;
            }

            // Double-tap detection (mobile)
            const now = Date.now();
            if (now - lastTap < 350 && dragNode === null) {
                ideaMapShowPopover(el, id);
                lastTap = 0;
                e.preventDefault();
                return;
            }
            lastTap = now;

            // Start drag
            const pos = ideaMapState.positions[id];
            if (!pos) return;
            dragNode = id;
            didDrag = false;
            dragStartX = coords.x;
            dragStartY = coords.y;
            dragNodeStartX = pos.x;
            dragNodeStartY = pos.y;
            e.preventDefault();
        }

        function onPointerMove(e) {
            if (!dragNode) return;
            const coords = svgCoords(e);
            const dx = (coords.x - dragStartX) / ideaMapState.zoom;
            const dy = (coords.y - dragStartY) / ideaMapState.zoom;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true;
            ideaMapState.positions[dragNode] = {
                x: dragNodeStartX + dx,
                y: dragNodeStartY + dy
            };
            // Move the node group directly for smooth dragging
            const nodeEl = svg.querySelector(`g[data-id="${dragNode}"]`);
            if (nodeEl) {
                const rect = nodeEl.querySelector('rect');
                const text = nodeEl.querySelector('text');
                const pos = ideaMapState.positions[dragNode];
                if (rect) { rect.setAttribute('x', pos.x); rect.setAttribute('y', pos.y); }
                if (text) { text.setAttribute('x', pos.x + 90); text.setAttribute('y', pos.y + 23); }
            }
            // Update connected edges
            svg.querySelectorAll('line').forEach(line => {
                // We need to find edges involving this node
                // Since lines don't have IDs, we'll just re-render on pointerup
            });
            e.preventDefault();
        }

        function onPointerUp(e) {
            if (dragNode) {
                ideaMapSavePositions();
                if (didDrag) {
                    // Full re-render to fix edge positions
                    ideaMapRender(el);
                }
                dragNode = null;
            }
        }

        // Double-click for desktop
        svg.addEventListener('dblclick', (e) => {
            const node = getNodeFromEvent(e);
            if (node) {
                ideaMapShowPopover(el, node.dataset.id);
                e.preventDefault();
            }
        });

        // Context menu
        svg.addEventListener('contextmenu', (e) => {
            const node = getNodeFromEvent(e);
            if (node) {
                e.preventDefault();
                ideaMapShowContextMenu(el, node.dataset.id, e.clientX, e.clientY);
            }
        });

        // Mouse events
        svg.addEventListener('mousedown', onPointerDown);
        document.addEventListener('mousemove', onPointerMove);
        document.addEventListener('mouseup', onPointerUp);

        // Touch events
        svg.addEventListener('touchstart', onPointerDown, { passive: false });
        document.addEventListener('touchmove', onPointerMove, { passive: false });
        document.addEventListener('touchend', onPointerUp);

        // Wheel zoom
        wrap.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.08 : 0.08;
            ideaMapState.zoom = Math.max(0.3, Math.min(3, ideaMapState.zoom + delta));
            svg.style.transform = `scale(${ideaMapState.zoom}) translate(${ideaMapState.panX}px, ${ideaMapState.panY}px)`;
            const label = el.querySelector('.ideamap-zoom-label');
            if (label) label.textContent = Math.round(ideaMapState.zoom * 100) + '%';
        }, { passive: false });

        // Pan with middle mouse or two-finger touch
        let isPanning = false;
        let panStartX = 0, panStartY = 0, panStartPanX = 0, panStartPanY = 0;

        wrap.addEventListener('mousedown', (e) => {
            if (e.button === 1 || (e.button === 0 && !getNodeFromEvent(e) && !ideaMapState.connectMode)) {
                isPanning = true;
                panStartX = e.clientX;
                panStartY = e.clientY;
                panStartPanX = ideaMapState.panX;
                panStartPanY = ideaMapState.panY;
                e.preventDefault();
            }
        });
        document.addEventListener('mousemove', (e) => {
            if (!isPanning) return;
            ideaMapState.panX = panStartPanX + (e.clientX - panStartX) / ideaMapState.zoom;
            ideaMapState.panY = panStartPanY + (e.clientY - panStartY) / ideaMapState.zoom;
            svg.style.transform = `scale(${ideaMapState.zoom}) translate(${ideaMapState.panX}px, ${ideaMapState.panY}px)`;
        });
        document.addEventListener('mouseup', () => { isPanning = false; });

        // Pinch-to-zoom (mobile)
        let lastPinchDist = 0;
        wrap.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                lastPinchDist = Math.sqrt(dx * dx + dy * dy);
            }
        }, { passive: true });
        wrap.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const delta = (dist - lastPinchDist) * 0.005;
                ideaMapState.zoom = Math.max(0.3, Math.min(3, ideaMapState.zoom + delta));
                lastPinchDist = dist;
                svg.style.transform = `scale(${ideaMapState.zoom}) translate(${ideaMapState.panX}px, ${ideaMapState.panY}px)`;
                const label = el.querySelector('.ideamap-zoom-label');
                if (label) label.textContent = Math.round(ideaMapState.zoom * 100) + '%';
                e.preventDefault();
            }
        }, { passive: false });
    }

    function ideaMapShowPopover(el, ideaId) {
        const idea = ideaMapState.ideas.find(i => i.id === ideaId);
        if (!idea) return;
        const popover = el.querySelector('#ideamap-popover');
        if (!popover) return;

        const tags = ideaMapGetTags(idea);
        const status = idea.status || idea.type || 'idea';

        popover.innerHTML = `
            <div class="ideamap-popover-header">
                <span class="ideamap-popover-title">Edit Idea</span>
                <button class="ideamap-popover-close" id="ideamap-popover-close">&times;</button>
            </div>
            <label class="ideamap-popover-label">Name</label>
            <input class="ideamap-popover-input" id="ideamap-pop-name" value="${escAttr(idea.name)}" />
            <label class="ideamap-popover-label">Status</label>
            <select class="ideamap-popover-select" id="ideamap-pop-status">
                <option value="idea" ${status === 'idea' ? 'selected' : ''}>Idea</option>
                <option value="incubator" ${status === 'incubator' ? 'selected' : ''}>Incubator</option>
                <option value="in-progress" ${status === 'in-progress' ? 'selected' : ''}>In Progress</option>
                <option value="converted" ${status === 'converted' ? 'selected' : ''}>Converted / Posted</option>
                <option value="hook" ${status === 'hook' ? 'selected' : ''}>Hook</option>
            </select>
            <label class="ideamap-popover-label">Tags (comma-separated)</label>
            <input class="ideamap-popover-input" id="ideamap-pop-tags" value="${escAttr(tags.join(', '))}" />
            <label class="ideamap-popover-label">Project</label>
            <input class="ideamap-popover-input" id="ideamap-pop-project" value="${escAttr(idea.project || '')}" />
            <button class="ideamap-popover-save" id="ideamap-pop-save">Save</button>
        `;
        popover.style.display = '';

        popover.querySelector('#ideamap-popover-close').addEventListener('click', () => {
            popover.style.display = 'none';
        });

        popover.querySelector('#ideamap-pop-save').addEventListener('click', async () => {
            const name = popover.querySelector('#ideamap-pop-name').value.trim();
            const newStatus = popover.querySelector('#ideamap-pop-status').value;
            const tagsStr = popover.querySelector('#ideamap-pop-tags').value;
            const project = popover.querySelector('#ideamap-pop-project').value.trim();
            const newTags = tagsStr.split(',').map(t => t.trim()).filter(Boolean);

            await NotesService.update(ideaId, {
                name: name || idea.name,
                status: newStatus,
                tags: JSON.stringify(newTags),
                project: project,
                type: newStatus === 'converted' ? 'converted' : 'idea'
            });
            // Update local state
            const idx = ideaMapState.ideas.findIndex(i => i.id === ideaId);
            if (idx >= 0) {
                Object.assign(ideaMapState.ideas[idx], {
                    name: name || idea.name,
                    status: newStatus,
                    tags: JSON.stringify(newTags),
                    project: project
                });
            }
            popover.style.display = 'none';
            ideaMapRender(el);
        });
    }

    function ideaMapShowContextMenu(el, ideaId, clientX, clientY) {
        // Remove existing context menu
        el.querySelectorAll('.ideamap-ctx').forEach(m => m.remove());

        const menu = document.createElement('div');
        menu.className = 'ideamap-ctx';
        menu.style.left = clientX + 'px';
        menu.style.top = clientY + 'px';

        const colors = [
            { label: 'Blue (Idea)', color: '#4a9eff' },
            { label: 'Gold (Incubator)', color: '#e8a020' },
            { label: 'Orange (In Progress)', color: '#e67e22' },
            { label: 'Green (Posted)', color: '#2ecc71' },
            { label: 'Purple (Hook)', color: '#9b59b6' }
        ];

        menu.innerHTML = `
            <div class="ideamap-ctx-title">Change Color</div>
            ${colors.map(c => `<div class="ideamap-ctx-item" data-color="${c.color}">
                <span class="ideamap-ctx-swatch" style="background:${c.color}"></span>${c.label}
            </div>`).join('')}
            <div class="ideamap-ctx-divider"></div>
            <div class="ideamap-ctx-item" data-action="delete-edges">Remove All Connections</div>
            <div class="ideamap-ctx-item" data-action="connect">Add Connection</div>
        `;

        el.appendChild(menu);

        menu.addEventListener('click', (e) => {
            const item = e.target.closest('.ideamap-ctx-item');
            if (!item) return;
            const color = item.dataset.color;
            const action = item.dataset.action;

            if (color) {
                ideaMapState.colors[ideaId] = color;
                ideaMapSaveColors();
            } else if (action === 'delete-edges') {
                ideaMapState.edges = ideaMapState.edges.filter(ed => ed.from !== ideaId && ed.to !== ideaId);
                ideaMapSaveEdges();
            } else if (action === 'connect') {
                ideaMapState.connectMode = true;
                ideaMapState.connectFrom = ideaId;
            }
            menu.remove();
            ideaMapRender(el);
        });

        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', function closeCtx() {
                menu.remove();
                document.removeEventListener('click', closeCtx);
            }, { once: true });
        }, 10);
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
            if (freeNoteSaveTimer) { clearTimeout(freeNoteSaveTimer); saveFreeNote(); }
            if (noteSaveTimer) { clearTimeout(noteSaveTimer); saveNote(); }
            if (videoSaveTimer) { clearTimeout(videoSaveTimer); saveVideo(); }
            container = null; selectedNote = null;
            selectedVideo = null; videoDirty = false;
            selectedFreeNote = null; freeNoteDirty = false;
            noteDirty = false;
            // Keep todoLoaded/todoItems, calendarLoaded/calendarItems, sponsorsLoaded cached across close/open
            freeNotesLoaded = false;
            calendarViewMode = 'week'; calendarSelectedDate = null;
            sponsorsLoaded = false;
            editingSponsor = null; editingSponsorVideo = null; sponsorsSubTab = 'companies';
            projectsLoaded = false; selectedProject = null;
            ideaMapState.loaded = false;
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
        // Public: preload sponsors count for HUD badge + expected income
        async preloadSponsorsCount() {
            await loadConfig();
            if (!sponsorsLoaded) {
                try {
                    const data = await fetchSponsors();
                    sponsorCompanies = data.companies;
                    sponsorVideos = data.videos;
                    sponsorsLoaded = true;
                } catch (e) {}
            }
            updateSponsorsBadge();
            if (typeof updateFinanceDisplay === 'function') updateFinanceDisplay();
        },
        getExpectedIncomeCAD() {
            return getExpectedIncomeCADInternal();
        },
        getSponsorsBadgeCount() {
            return sponsorVideos.filter(v => v.status !== 'paid' && v.status !== 'cancelled' && v.status !== 'invoiced').length;
        }
    };
})();

BuildingRegistry.register('Library', {
    open: (bodyEl, opts) => LibraryUI.open(bodyEl, opts),
    close: () => LibraryUI.close()
});
