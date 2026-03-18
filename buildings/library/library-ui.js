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

    // Cache of real project names (Dropbox folders) — used to filter fake project badges
    let realProjectsCache = null;
    VideoService.getProjects().then(p => { realProjectsCache = p; renderNotesList(); }).catch(() => { realProjectsCache = []; });

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
        // Event delegation: handles tabs added after initial render (e.g. Idea Map)
        container.querySelector('.library-tabs').addEventListener('click', (e) => {
            const tab = e.target.closest('.library-tab');
            if (tab && tab.dataset.tab) switchTab(tab.dataset.tab);
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
            if (heading) heading.innerHTML = 'Ideas <span class="library-ideas-legend"><span class="library-legend-dot has-context"></span> Context &nbsp;<span class="library-legend-dot dot-script has-script"></span> Script</span>';
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
            // Scroll list page to top so ideamap is visible
            const listPage = document.getElementById('library-list-page');
            if (listPage) listPage.scrollTop = 0;
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
            const isRealProject = realProjectsCache && n.project && realProjectsCache.includes(n.project);
            const badge = isRealProject && window.EggRenderer ? window.EggRenderer.projectBadgeHtml(n.project) : '';
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
                    <div class="library-list-title">${escHtml(n.name)}${statusHtml}<span class="library-idea-dots"><span class="library-idea-dot${n.context ? ' has-context' : ''}"></span><span class="library-idea-dot dot-script${n.script ? ' has-script' : ''}"></span></span></div>
                    <div class="library-list-date">${badge ? `<button class="library-project-badge-btn" data-project="${escAttr(n.project)}">${badge}</button>` : escHtml(preview ? preview.substring(0, 60) : 'idea')}</div>
                </div>
                <button class="library-delete-btn" data-note-id="${n.id}" title="Delete">&times;</button>
            </div>`;
        }).join('');

        el.querySelectorAll('.library-list-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('library-delete-btn')) return;
                if (e.target.closest('.library-project-badge-btn')) return;
                selectNote(item.dataset.noteId);
            });
        });
        el.querySelectorAll('.library-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); handleDeleteNote(btn.dataset.noteId); });
        });
        el.querySelectorAll('.library-project-badge-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const proj = btn.dataset.project;
                if (proj) { switchTab('projects'); selectedProject = proj; renderProjectsList(); }
            });
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
        let projs = [];
        try {
            projs = await VideoService.getProjects();
            const isRealProject = note.project && projs.includes(note.project);
            projectOptions = projs.map(p => `<option value="${escAttr(p)}" ${isRealProject && p === note.project ? 'selected' : ''}>${escHtml(p)}</option>`).join('');
        } catch (e) {}
        const isLinkedProject = note.project && projs.includes(note.project);

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
        const expandIcon = `<button class="library-script-expand-btn" data-expand-script="library-idea-script" title="Expand"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg></button>`;
        const scriptSection = `
            <div class="library-idea-field">
                <label class="library-idea-label">Script ${expandIcon}</label>
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
                    <label class="library-meta-label">Link to Dropbox Project</label>
                    <div style="display:flex;align-items:center;gap:6px;">
                        <select class="library-project-select" id="library-note-project" style="flex:1;">
                            <option value="">None</option>
                            ${projectOptions}
                        </select>
                        ${isLinkedProject ? `<button class="library-view-project-btn" id="library-view-project-btn" title="View Project">View Project</button>` : ''}
                    </div>
                </div>
                <div class="library-idea-field">
                    <label class="library-idea-label">Related to</label>
                    <textarea class="library-idea-related" id="library-idea-related" placeholder="Describe relationships to other ideas or projects...">${escHtml(note.relatedTo || '')}</textarea>
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
        document.getElementById('library-idea-related').addEventListener('input', scheduleNoteSave);
        document.getElementById('library-idea-script').addEventListener('click', () => {
            openScriptOverlay(document.getElementById('library-idea-script'), scheduleNoteSave);
        });
        const ideaExpandBtn = document.querySelector('[data-expand-script="library-idea-script"]');
        if (ideaExpandBtn) ideaExpandBtn.addEventListener('click', () => {
            openScriptOverlay(document.getElementById('library-idea-script'), scheduleNoteSave);
        });
        const viewProjBtn = document.getElementById('library-view-project-btn');
        if (viewProjBtn) viewProjBtn.addEventListener('click', () => {
            const proj = document.getElementById('library-note-project')?.value;
            if (proj) { switchTab('projects'); selectedProject = proj; renderProjectsList(); }
        });
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

    function openScriptOverlay(scriptEl, saveFn) {
        const overlay = document.createElement('div');
        overlay.className = 'library-script-overlay';
        overlay.innerHTML = `
            <div class="library-script-overlay-header">
                <span class="script-overlay-label">Script</span>
                <button class="script-overlay-done">Done</button>
            </div>
            <textarea class="library-script-overlay-textarea"></textarea>
        `;
        const ta = overlay.querySelector('textarea');
        ta.value = scriptEl.value;
        document.body.appendChild(overlay);
        ta.focus();
        overlay.querySelector('.script-overlay-done').addEventListener('click', () => {
            scriptEl.value = ta.value;
            scriptEl.dispatchEvent(new Event('input', { bubbles: true }));
            overlay.remove();
            if (saveFn) saveFn();
        });
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
            const relatedEl = document.getElementById('library-idea-related');
            const newRelatedTo = relatedEl?.value || '';
            await NotesService.update(selectedNote.id, {
                name: newName,
                hook: newHook,
                context: newContext,
                script: newScript,
                project: newProject,
                relatedTo: newRelatedTo
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
        const videoExpandIcon = `<button class="library-script-expand-btn" data-expand-script="library-video-script" title="Expand"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg></button>`;
        const scriptSection = `
            <div class="library-idea-field">
                <label class="library-idea-label">Script ${videoExpandIcon}</label>
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
        document.getElementById('library-video-script').addEventListener('click', () => {
            openScriptOverlay(document.getElementById('library-video-script'), scheduleVideoSave);
        });
        const vidExpandBtn = document.querySelector('[data-expand-script="library-video-script"]');
        if (vidExpandBtn) vidExpandBtn.addEventListener('click', () => {
            openScriptOverlay(document.getElementById('library-video-script'), scheduleVideoSave);
        });
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
    // --- IDEA MAP (Kanban Grid) ---
    // =====================
    const IDEAMAP_STATUS_COLORS = {
        idea: '#4a9eff',
        incubator: '#e8a020',
        workshop: '#e67e22',
        edit: '#9b59b6',
        posted: '#2ecc71',
        'in-progress': '#e67e22',
        converted: '#2ecc71'
    };

    const IDEAMAP_CLUSTERS = {
        'Magnetism': ['magnetism', 'magnet'],
        'Flight': ['flight', 'drones'],
        'Bulletproof / Armor': ['bulletproof', 'helmet'],
        'Exoskeleton / Strength': ['exoskeleton', 'strength'],
        'Jet Engine': ['jet-engine'],
        'Jarvis / AI': ['jarvis', 'ai'],
        'Superhero Gadgets': ['superhero', 'gadget'],
        'Stunts / Survival': ['stunt', 'survival'],
        'Chemistry / Science': ['chemistry', 'science', 'materials', 'food'],
        '3D Printing': ['3d-printing'],
        'Other': []
    };

    const IDEAMAP_PRESET_COLORS = ['#4a9eff', '#e8a020', '#2ecc71', '#e74c3c', '#9b59b6', '#1abc9c'];

    let ideaMapState = {
        ideas: [],
        projects: null,
        filterStatus: 'all',
        filterCategory: 'all', // 'all' | categoryId | 'uncategorized'
        expandedCategoryFilter: null, // top-level category id expanded to show sub-cats
        groupBy: 'tag', // 'tag' | 'category' | 'project'
        collapsedClusters: {},
        showCategoryPanel: false,
        editingCategoryId: null,
        addingCategory: false,
        loaded: false,
        searchQuery: '',
        searchResults: null, // null = no search, array = search active
        searchLoading: false
    };
    let ideaMapSearchTimer = null;

    // --- Category data layer (localStorage) ---
    function ideaMapGetCategories() {
        try { return JSON.parse(localStorage.getItem('ideamap-categories') || '[]'); } catch(e) { return []; }
    }
    function ideaMapSaveCategories(cats) {
        localStorage.setItem('ideamap-categories', JSON.stringify(cats));
    }
    function ideaMapGetIdeaCategories() {
        try { return JSON.parse(localStorage.getItem('ideamap-idea-categories') || '{}'); } catch(e) { return {}; }
    }
    function ideaMapSaveIdeaCategories(mapping) {
        localStorage.setItem('ideamap-idea-categories', JSON.stringify(mapping));
    }
    function ideaMapGenId() {
        return 'cat_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
    }

    // Seed default categories if none exist
    function ideaMapInitCategories() {
        let cats = ideaMapGetCategories();
        if (cats.length > 0) return;
        const defaults = [
            { name: 'Bulletproof & Armor', color: '#e74c3c', children: ['Helmet Series', 'Suit Series'] },
            { name: 'Flight & Propulsion', color: '#4a9eff', children: ['Jet Engine Series', 'Drone Series'] },
            { name: 'Magnetism', color: '#9b59b6', children: [] },
            { name: 'Exoskeleton & Strength', color: '#e8a020', children: ['Strength Arm Series', 'Legs & Movement'] },
            { name: 'Jarvis & AI', color: '#2ecc71', children: [] },
            { name: 'Superhero Gadgets', color: '#e67e22', children: [] },
            { name: 'Stunts & Science', color: '#1abc9c', children: [] },
            { name: '3D Printing', color: '#95a5a6', children: [] }
        ];
        cats = [];
        for (const d of defaults) {
            const parentId = ideaMapGenId();
            cats.push({ id: parentId, name: d.name, parentId: null, color: d.color });
            for (const childName of d.children) {
                cats.push({ id: ideaMapGenId(), name: childName, parentId, color: d.color });
            }
        }
        ideaMapSaveCategories(cats);
    }

    // Seed idea-to-category mapping based on tags (only if mapping is empty)
    function ideaMapSeedIdeaCategories() {
        const mapping = ideaMapGetIdeaCategories();
        if (Object.keys(mapping).length > 0) return;
        const cats = ideaMapGetCategories();
        if (cats.length === 0) return;
        const findCat = (name) => cats.find(c => c.name === name);
        const tagRules = [
            { tags: ['bulletproof', 'helmet'], cat: 'Bulletproof & Armor' },
            { tags: ['flight'], cat: 'Flight & Propulsion' },
            { tags: ['jet-engine'], cat: 'Jet Engine Series' },
            { tags: ['magnetism'], cat: 'Magnetism' },
            { tags: ['exoskeleton', 'strength'], cat: 'Exoskeleton & Strength' },
            { tags: ['jarvis', 'ai'], cat: 'Jarvis & AI' },
            { tags: ['superhero'], cat: 'Superhero Gadgets' },
            { tags: ['3d-printing'], cat: '3D Printing' },
            { tags: ['stunt', 'science', 'chemistry'], cat: 'Stunts & Science' }
        ];
        const newMapping = {};
        for (const idea of ideaMapState.ideas) {
            const ideaTags = ideaMapGetTags(idea);
            if (ideaTags.length === 0) continue;
            for (const rule of tagRules) {
                if (rule.tags.some(t => ideaTags.includes(t))) {
                    const cat = findCat(rule.cat);
                    if (cat) { newMapping[idea.id] = cat.id; break; }
                }
            }
        }
        if (Object.keys(newMapping).length > 0) ideaMapSaveIdeaCategories(newMapping);
    }

    // Get category object for an idea
    function ideaMapGetIdeaCategory(ideaId) {
        const mapping = ideaMapGetIdeaCategories();
        const catId = mapping[ideaId];
        if (!catId) return null;
        const cats = ideaMapGetCategories();
        return cats.find(c => c.id === catId) || null;
    }

    // Get all descendant category IDs for a parent (including self)
    function ideaMapGetCategoryDescendants(catId) {
        const cats = ideaMapGetCategories();
        const ids = [catId];
        for (const c of cats) {
            if (c.parentId === catId) ids.push(c.id);
        }
        return ids;
    }

    function ideaMapGetCluster(idea) {
        const tags = ideaMapGetTags(idea);
        for (const [cluster, keywords] of Object.entries(IDEAMAP_CLUSTERS)) {
            if (cluster === 'Other') continue;
            if (keywords.some(k => tags.includes(k))) return cluster;
        }
        return 'Other';
    }

    function ideaMapGetTags(idea) {
        if (!idea.tags) return [];
        if (Array.isArray(idea.tags)) return idea.tags;
        try { return JSON.parse(idea.tags); } catch(e) { return []; }
    }

    function ideaMapGetStatus(idea) {
        if (idea.status) return idea.status;
        if (idea.type === 'converted') {
            const video = VideoService.getByIdeaId(idea.id);
            return video ? video.status : 'incubator';
        }
        return idea.type || 'idea';
    }

    function ideaMapStatusColor(status) {
        return IDEAMAP_STATUS_COLORS[status] || IDEAMAP_STATUS_COLORS.idea;
    }

    function ideaMapStatusLabel(status) {
        const labels = { idea: 'Idea', incubator: 'Incubator', workshop: 'Workshop', edit: 'Edit', posted: 'Posted', 'in-progress': 'In Progress', converted: 'Converted' };
        return labels[status] || status;
    }

    async function renderIdeaMap() {
        const el = document.getElementById('library-ideamap-container');
        if (!el) return;

        if (!ideaMapState.loaded) {
            el.innerHTML = '<div class="library-empty">Loading ideas...</div>';
            try {
                const resp = await fetch('/api/v1/ideas?key=c1224bb7d79e553506243f5aea9b13e0ed66b72e3135b67a');
                if (resp.ok) {
                    const data = await resp.json();
                    ideaMapState.ideas = Array.isArray(data) ? data : (data.ideas || data.records || []);
                } else {
                    await NotesService.sync(true).catch(() => {});
                    ideaMapState.ideas = NotesService.getAll().filter(n => n.type !== 'todo');
                }
            } catch (e) {
                await NotesService.sync(true).catch(() => {});
                ideaMapState.ideas = NotesService.getAll().filter(n => n.type !== 'todo');
            }
            ideaMapState.loaded = true;
            // Ensure videos are cached so ideaMapGetStatus can resolve converted ideas
            await VideoService.sync().catch(() => {});
            // Init categories & seed
            ideaMapInitCategories();
            ideaMapSeedIdeaCategories();
            // Auto-index embeddings in background if idea count changed
            const prevIndexed = parseInt(localStorage.getItem('ideamap-indexed-count') || '0', 10);
            if (prevIndexed !== ideaMapState.ideas.length) {
                fetch('/api/ideas/index-embeddings', { method: 'POST' })
                    .then(r => r.json())
                    .then(d => { if (d.indexed) localStorage.setItem('ideamap-indexed-count', String(d.indexed)); })
                    .catch(() => {});
            }
        }

        if (!ideaMapState.projects) {
            try { ideaMapState.projects = await VideoService.getProjects(); }
            catch (e) { ideaMapState.projects = []; }
        }

        ideaMapRenderKanban(el);
    }

    // --- Apply both status and category filters ---
    function ideaMapFilterIdeas(ideas) {
        const sf = ideaMapState.filterStatus;
        const cf = ideaMapState.filterCategory;
        let filtered = ideas;
        if (sf !== 'all') {
            filtered = filtered.filter(i => {
                const s = ideaMapGetStatus(i);
                return s === sf;
            });
        }
        if (cf !== 'all') {
            const mapping = ideaMapGetIdeaCategories();
            if (cf === 'uncategorized') {
                filtered = filtered.filter(i => !mapping[i.id]);
            } else {
                const validIds = ideaMapGetCategoryDescendants(cf);
                filtered = filtered.filter(i => validIds.includes(mapping[i.id]));
            }
        }
        return filtered;
    }

    function ideaMapRenderKanban(el) {
        let ideas = ideaMapFilterIdeas(ideaMapState.ideas);
        const groupBy = ideaMapState.groupBy;

        // --- Toolbar ---
        let html = `<div class="ideamap-toolbar">
            <div class="ideamap-toolbar-left">
                <span class="ideamap-toolbar-label">Group by:</span>
                <button class="ideamap-group-btn${groupBy === 'tag' ? ' active' : ''}" data-group="tag">By Tag</button>
                <button class="ideamap-group-btn${groupBy === 'category' ? ' active' : ''}" data-group="category">By Category</button>
                <button class="ideamap-group-btn${groupBy === 'project' ? ' active' : ''}" data-group="project">By Project</button>
            </div>
            <button class="ideamap-manage-cats-btn" id="ideamap-manage-cats-btn">Manage Categories</button>
        </div>`;

        // --- Status filter row ---
        const sf = ideaMapState.filterStatus;
        const statusFilters = [
            { key: 'all', label: 'All' },
            { key: 'idea', label: 'Ideas' },
            { key: 'incubator', label: 'Incubator' },
            { key: 'workshop', label: 'Workshop' },
            { key: 'posted', label: 'Posted' }
        ];
        // Pre-count per status across ALL ideas (unfiltered)
        const allIdeas = ideaMapState.ideas;
        const statusCounts = {};
        for (const idea of allIdeas) {
            const s = ideaMapGetStatus(idea);
            const key = (s === 'converted' || s === 'posted') ? 'posted' : s;
            statusCounts[key] = (statusCounts[key] || 0) + 1;
        }
        statusCounts.all = allIdeas.length;

        html += `<div class="ideamap-filter-bar">`;
        html += `<span class="ideamap-filter-row-label">Status:</span>`;
        for (const f of statusFilters) {
            const active = sf === f.key || (f.key === 'posted' && sf === 'converted');
            const cnt = statusCounts[f.key] || 0;
            const cntHtml = cnt > 0 ? ` <span class="ideamap-pill-count">${cnt}</span>` : '';
            html += `<button class="ideamap-filter-pill${active ? ' active' : ''}" data-filter-status="${f.key}">${f.label}${cntHtml}</button>`;
        }
        html += `</div>`;

        // --- Category filter row ---
        const cf = ideaMapState.filterCategory;
        const cats = ideaMapGetCategories();
        const topCats = cats.filter(c => !c.parentId);
        const ideaCatMap = ideaMapState.ideaCategories || {};

        // Count ideas per category
        const catCounts = {};
        let uncategorizedCount = 0;
        for (const idea of allIdeas) {
            const catId = ideaCatMap[idea.id];
            if (catId) {
                catCounts[catId] = (catCounts[catId] || 0) + 1;
                // Also count toward parent
                const cat = cats.find(c => c.id === catId);
                if (cat && cat.parentId) catCounts[cat.parentId] = (catCounts[cat.parentId] || 0) + 1;
            } else {
                uncategorizedCount++;
            }
        }

        html += `<div class="ideamap-filter-bar ideamap-filter-bar-cat">`;
        html += `<span class="ideamap-filter-row-label">Category:</span>`;
        html += `<button class="ideamap-filter-pill${cf === 'all' ? ' active' : ''}" data-filter-cat="all">All <span class="ideamap-pill-count">${allIdeas.length}</span></button>`;
        for (const tc of topCats) {
            const isActive = cf === tc.id;
            const isExpanded = ideaMapState.expandedCategoryFilter === tc.id;
            const cnt = catCounts[tc.id] || 0;
            const cntHtml = cnt > 0 ? ` <span class="ideamap-pill-count">${cnt}</span>` : '';
            html += `<button class="ideamap-filter-pill${isActive ? ' active' : ''}" data-filter-cat="${tc.id}" style="border-left: 3px solid ${tc.color}">${escHtml(tc.name)}${cntHtml}</button>`;
            if (isExpanded) {
                const subCats = cats.filter(c => c.parentId === tc.id);
                for (const sc of subCats) {
                    const scCnt = catCounts[sc.id] || 0;
                    const scCntHtml = scCnt > 0 ? ` <span class="ideamap-pill-count">${scCnt}</span>` : '';
                    html += `<button class="ideamap-filter-pill ideamap-filter-subpill${cf === sc.id ? ' active' : ''}" data-filter-cat="${sc.id}">${escHtml(sc.name)}${scCntHtml}</button>`;
                }
            }
        }
        const uncatCntHtml = uncategorizedCount > 0 ? ` <span class="ideamap-pill-count">${uncategorizedCount}</span>` : '';
        html += `<button class="ideamap-filter-pill${cf === 'uncategorized' ? ' active' : ''}" data-filter-cat="uncategorized">Uncategorized${uncatCntHtml}</button>`;
        html += `</div>`;

        // --- Search bar ---
        html += `<div class="ideamap-search-bar">
            <input type="text" class="ideamap-search-input" id="ideamap-search-input" placeholder="Search ideas by meaning..." value="${escAttr(ideaMapState.searchQuery)}" />
            ${ideaMapState.searchQuery ? `<button class="ideamap-search-clear" id="ideamap-search-clear" title="Clear search">&times;</button>` : ''}
            <button class="ideamap-search-btn" id="ideamap-search-btn" title="Search">
                ${ideaMapState.searchLoading ? '<span class="ideamap-search-spinner"></span>' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5a3e1b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'}
            </button>
        </div>`;

        // --- Search results mode ---
        if (ideaMapState.searchResults !== null) {
            const results = ideaMapState.searchResults;
            html += `<div class="ideamap-search-results-header">
                <span>Search results for '${escHtml(ideaMapState.searchQuery)}' (${results.length})</span>
                <button class="ideamap-search-clear" id="ideamap-search-results-clear">&times;</button>
            </div>`;
            if (results.length === 0) {
                html += `<div class="library-empty">No ideas found for '${escHtml(ideaMapState.searchQuery)}'</div>`;
            } else {
                html += `<div class="ideamap-kanban-scroll"><div class="ideamap-card-row ideamap-search-card-row">`;
                for (const r of results) {
                    const idea = ideaMapState.ideas.find(i => i.id === r.id);
                    const status = idea ? ideaMapGetStatus(idea) : r.status;
                    const color = ideaMapStatusColor(status);
                    const tags = idea ? ideaMapGetTags(idea) : (r.tags ? r.tags.split(',').map(t => t.trim()).filter(Boolean) : []);
                    const name = idea ? idea.name : r.name;
                    const pct = Math.round((r.score || 0) * 100);
                    html += `<div class="ideamap-card" data-id="${r.id}">
                        <div class="ideamap-card-border" style="background:${color}"></div>
                        <div class="ideamap-card-body">
                            <div class="ideamap-card-name">${escHtml(name)}</div>
                            <span class="ideamap-card-badge" style="background:${color}">${escHtml(ideaMapStatusLabel(status))}</span>
                            ${tags.length ? `<div class="ideamap-card-tags">${tags.map(t => `<span class="ideamap-card-tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
                            <div class="ideamap-score-bar"><div class="ideamap-score-fill" style="width:${pct}%"></div></div>
                        </div>
                    </div>`;
                }
                html += `</div></div>`;
            }

            // Popover
            html += `<div class="ideamap-popover" id="ideamap-popover" style="display:none;"></div>`;
            el.innerHTML = html;
            ideaMapBindSearchEvents(el);
            ideaMapBindKanbanEvents(el);
            return;
        }

        // --- Build cluster groups based on groupBy ---
        let clusterOrder = [];
        let clusters = {};

        if (groupBy === 'tag') {
            clusterOrder = Object.keys(IDEAMAP_CLUSTERS);
            for (const cName of clusterOrder) clusters[cName] = [];
            for (const idea of ideas) {
                const c = ideaMapGetCluster(idea);
                if (!clusters[c]) clusters[c] = [];
                clusters[c].push(idea);
            }
        } else if (groupBy === 'category') {
            const mapping = ideaMapGetIdeaCategories();
            for (const tc of topCats) {
                clusterOrder.push(tc.name);
                const descIds = ideaMapGetCategoryDescendants(tc.id);
                clusters[tc.name] = ideas.filter(i => descIds.includes(mapping[i.id]));
            }
            clusterOrder.push('Uncategorized');
            clusters['Uncategorized'] = ideas.filter(i => !mapping[i.id]);
        } else if (groupBy === 'project') {
            const projectGroups = {};
            for (const idea of ideas) {
                const proj = idea.project || null;
                const key = proj || '__no_project__';
                if (!projectGroups[key]) projectGroups[key] = [];
                projectGroups[key].push(idea);
            }
            // Real projects first, then No Project
            const projNames = Object.keys(projectGroups).filter(k => k !== '__no_project__').sort();
            for (const p of projNames) { clusterOrder.push(p); clusters[p] = projectGroups[p]; }
            if (projectGroups['__no_project__'] && projectGroups['__no_project__'].length > 0) {
                clusterOrder.push('No Project');
                clusters['No Project'] = projectGroups['__no_project__'];
            }
        }

        // --- Cluster sections ---
        html += `<div class="ideamap-kanban-scroll">`;
        const mapping = ideaMapGetIdeaCategories();
        for (const cName of clusterOrder) {
            const cIdeas = clusters[cName];
            if (!cIdeas || cIdeas.length === 0) continue;
            const collapsed = ideaMapState.collapsedClusters[cName];
            html += `<div class="ideamap-cluster">
                <div class="ideamap-cluster-header" data-cluster="${escAttr(cName)}">
                    <span class="ideamap-cluster-arrow">${collapsed ? '\u25B6' : '\u25BC'}</span>
                    <span class="ideamap-cluster-name">${escHtml(cName)}</span>
                    <span class="ideamap-cluster-count">${cIdeas.length}</span>
                </div>`;
            if (!collapsed) {
                html += `<div class="ideamap-card-row">`;
                for (const idea of cIdeas) {
                    const status = ideaMapGetStatus(idea);
                    const color = ideaMapStatusColor(status);
                    const tags = ideaMapGetTags(idea);
                    // Series badge: show sub-category name if idea belongs to a sub-category
                    const ideaCat = ideaMapGetIdeaCategory(idea.id);
                    const seriesBadge = ideaCat && ideaCat.parentId ? `<span class="ideamap-card-series" style="border-color:${ideaCat.color}">${escHtml(ideaCat.name)}</span>` : '';
                    const projColor = (idea.project && ideaMapState.projects && ideaMapState.projects.includes(idea.project) && window.EggRenderer) ? window.EggRenderer.getProjectColor(idea.project) : null;
                    html += `<div class="ideamap-card" data-id="${idea.id}">
                        <div class="ideamap-card-border" style="background:${color}"></div>
                        <div class="ideamap-card-body">
                            ${projColor ? `<span class="ideamap-project-dot" style="background:${projColor}"></span>` : ''}
                            <div class="ideamap-card-name">${escHtml(idea.name)}</div>
                            <span class="ideamap-card-badge" style="background:${color}">${escHtml(ideaMapStatusLabel(status))}</span>
                            <span class="library-idea-dots"><span class="library-idea-dot${idea.context ? ' has-context' : ''}"></span><span class="library-idea-dot dot-script${idea.script ? ' has-script' : ''}"></span></span>
                            ${seriesBadge}
                            ${tags.length ? `<div class="ideamap-card-tags">${tags.map(t => `<span class="ideamap-card-tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
                        </div>
                    </div>`;
                }
                html += `</div>`;
            }
            html += `</div>`;
        }
        html += `</div>`;

        // Manage categories panel (slides in from right)
        if (ideaMapState.showCategoryPanel) {
            html += ideaMapRenderCategoryPanel();
        }

        // Detail popover (hidden)
        html += `<div class="ideamap-popover" id="ideamap-popover" style="display:none;"></div>`;

        el.innerHTML = html;
        ideaMapBindKanbanEvents(el);
    }

    // --- Manage Categories Panel ---
    function ideaMapRenderCategoryPanel() {
        const cats = ideaMapGetCategories();
        const topCats = cats.filter(c => !c.parentId);
        let html = `<div class="ideamap-cat-panel" id="ideamap-cat-panel">
            <div class="ideamap-cat-panel-header">
                <span class="ideamap-cat-panel-title">Manage Categories</span>
                <button class="ideamap-popover-close" id="ideamap-cat-panel-close">&times;</button>
            </div>`;

        // Add category button / form
        if (ideaMapState.addingCategory) {
            html += `<div class="ideamap-cat-add-form" id="ideamap-cat-add-form">
                <input type="text" class="ideamap-cat-input" id="ideamap-cat-add-name" placeholder="Category name..." />
                <div class="ideamap-cat-color-row">
                    ${IDEAMAP_PRESET_COLORS.map((c, i) => `<button class="ideamap-cat-color-btn${i === 0 ? ' selected' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}
                </div>
                <select class="ideamap-popover-select ideamap-cat-parent-select" id="ideamap-cat-add-parent">
                    <option value="">No parent (top-level)</option>
                    ${topCats.map(tc => `<option value="${tc.id}">${escHtml(tc.name)}</option>`).join('')}
                </select>
                <div class="ideamap-cat-form-actions">
                    <button class="ideamap-cat-save-btn" id="ideamap-cat-add-save">Save</button>
                    <button class="ideamap-cat-cancel-btn" id="ideamap-cat-add-cancel">Cancel</button>
                </div>
            </div>`;
        } else {
            html += `<button class="ideamap-cat-add-btn" id="ideamap-cat-add-btn">+ Add Category</button>`;
        }

        // Tree view
        html += `<div class="ideamap-cat-tree">`;
        for (const tc of topCats) {
            const children = cats.filter(c => c.parentId === tc.id);
            const isEditing = ideaMapState.editingCategoryId === tc.id;
            if (isEditing) {
                html += ideaMapRenderCatEditRow(tc, topCats);
            } else {
                html += `<div class="ideamap-cat-row">
                    <span class="ideamap-cat-dot" style="background:${tc.color}"></span>
                    <span class="ideamap-cat-name">${escHtml(tc.name)}</span>
                    <button class="ideamap-cat-edit-btn" data-cat-id="${tc.id}" title="Edit">&#9998;</button>
                    <button class="ideamap-cat-delete-btn" data-cat-id="${tc.id}" title="Delete">&times;</button>
                </div>`;
            }
            for (const ch of children) {
                const isEditingChild = ideaMapState.editingCategoryId === ch.id;
                if (isEditingChild) {
                    html += `<div class="ideamap-cat-child-indent">${ideaMapRenderCatEditRow(ch, topCats)}</div>`;
                } else {
                    html += `<div class="ideamap-cat-row ideamap-cat-child-indent">
                        <span class="ideamap-cat-dot" style="background:${ch.color}"></span>
                        <span class="ideamap-cat-name">${escHtml(ch.name)}</span>
                        <button class="ideamap-cat-edit-btn" data-cat-id="${ch.id}" title="Edit">&#9998;</button>
                        <button class="ideamap-cat-delete-btn" data-cat-id="${ch.id}" title="Delete">&times;</button>
                    </div>`;
                }
            }
        }
        html += `</div></div>`;
        return html;
    }

    function ideaMapRenderCatEditRow(cat, topCats) {
        return `<div class="ideamap-cat-add-form ideamap-cat-edit-form" data-edit-id="${cat.id}">
            <input type="text" class="ideamap-cat-input" id="ideamap-cat-edit-name-${cat.id}" value="${escAttr(cat.name)}" />
            <div class="ideamap-cat-color-row">
                ${IDEAMAP_PRESET_COLORS.map(c => `<button class="ideamap-cat-color-btn${c === cat.color ? ' selected' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}
            </div>
            <select class="ideamap-popover-select ideamap-cat-parent-select" id="ideamap-cat-edit-parent-${cat.id}">
                <option value="">No parent (top-level)</option>
                ${topCats.filter(tc => tc.id !== cat.id).map(tc => `<option value="${tc.id}" ${cat.parentId === tc.id ? 'selected' : ''}>${escHtml(tc.name)}</option>`).join('')}
            </select>
            <div class="ideamap-cat-form-actions">
                <button class="ideamap-cat-save-btn ideamap-cat-edit-save" data-cat-id="${cat.id}">Save</button>
                <button class="ideamap-cat-cancel-btn ideamap-cat-edit-cancel">Cancel</button>
            </div>
        </div>`;
    }

    function ideaMapBindSearchEvents(el) {
        const searchInput = el.querySelector('#ideamap-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                ideaMapState.searchQuery = searchInput.value;
                if (ideaMapSearchTimer) clearTimeout(ideaMapSearchTimer);
                if (!searchInput.value.trim()) {
                    ideaMapState.searchResults = null;
                    ideaMapState.searchLoading = false;
                    ideaMapRenderKanban(el);
                    return;
                }
                ideaMapSearchTimer = setTimeout(() => ideaMapDoSearch(el), 400);
            });
            // Focus the input and put cursor at end
            searchInput.focus();
            searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
        }
        const searchBtn = el.querySelector('#ideamap-search-btn');
        if (searchBtn) {
            searchBtn.addEventListener('click', () => {
                if (ideaMapState.searchQuery.trim()) ideaMapDoSearch(el);
            });
        }
        const clearBtn = el.querySelector('#ideamap-search-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                ideaMapState.searchQuery = '';
                ideaMapState.searchResults = null;
                ideaMapState.searchLoading = false;
                ideaMapRenderKanban(el);
            });
        }
        const resultsClear = el.querySelector('#ideamap-search-results-clear');
        if (resultsClear) {
            resultsClear.addEventListener('click', () => {
                ideaMapState.searchQuery = '';
                ideaMapState.searchResults = null;
                ideaMapState.searchLoading = false;
                ideaMapRenderKanban(el);
            });
        }
    }

    async function ideaMapDoSearch(el) {
        ideaMapState.searchLoading = true;
        ideaMapRenderKanban(el);
        try {
            const resp = await fetch('/api/ideas/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: ideaMapState.searchQuery,
                    topK: 15,
                    statusFilter: ideaMapState.filterStatus
                })
            });
            if (!resp.ok) throw new Error('Search failed');
            const data = await resp.json();
            ideaMapState.searchResults = data.results || [];
        } catch (e) {
            console.error('Idea search error:', e);
            ideaMapState.searchResults = [];
        }
        ideaMapState.searchLoading = false;
        ideaMapRenderKanban(el);
    }

    function ideaMapBindKanbanEvents(el) {
        // Bind search events
        ideaMapBindSearchEvents(el);
        // Group-by buttons
        el.querySelectorAll('.ideamap-group-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                ideaMapState.groupBy = btn.dataset.group;
                ideaMapRenderKanban(el);
            });
        });

        // Manage Categories button
        const manageCatsBtn = el.querySelector('#ideamap-manage-cats-btn');
        if (manageCatsBtn) {
            manageCatsBtn.addEventListener('click', () => {
                ideaMapState.showCategoryPanel = !ideaMapState.showCategoryPanel;
                ideaMapState.editingCategoryId = null;
                ideaMapState.addingCategory = false;
                ideaMapRenderKanban(el);
            });
        }

        // Status filter pills
        el.querySelectorAll('[data-filter-status]').forEach(btn => {
            btn.addEventListener('click', () => {
                ideaMapState.filterStatus = btn.dataset.filterStatus;
                ideaMapRenderKanban(el);
            });
        });

        // Category filter pills
        el.querySelectorAll('[data-filter-cat]').forEach(btn => {
            btn.addEventListener('click', () => {
                const catId = btn.dataset.filterCat;
                if (catId === 'all' || catId === 'uncategorized') {
                    ideaMapState.filterCategory = catId;
                    ideaMapState.expandedCategoryFilter = null;
                } else {
                    const cats = ideaMapGetCategories();
                    const cat = cats.find(c => c.id === catId);
                    if (cat && !cat.parentId) {
                        // Top-level: toggle expand or select
                        if (ideaMapState.filterCategory === catId) {
                            // Already selected, toggle expand
                            ideaMapState.expandedCategoryFilter = ideaMapState.expandedCategoryFilter === catId ? null : catId;
                        } else {
                            ideaMapState.filterCategory = catId;
                            ideaMapState.expandedCategoryFilter = catId;
                        }
                    } else {
                        // Sub-category
                        ideaMapState.filterCategory = catId;
                    }
                }
                ideaMapRenderKanban(el);
            });
        });

        // Cluster collapse/expand
        el.querySelectorAll('.ideamap-cluster-header').forEach(header => {
            header.addEventListener('click', () => {
                const cName = header.dataset.cluster;
                ideaMapState.collapsedClusters[cName] = !ideaMapState.collapsedClusters[cName];
                ideaMapRenderKanban(el);
            });
        });

        // Card tap → popover
        el.querySelectorAll('.ideamap-card').forEach(card => {
            card.addEventListener('click', () => {
                ideaMapShowCardPopover(el, card.dataset.id);
            });
        });

        // --- Category panel events ---
        const catPanelClose = el.querySelector('#ideamap-cat-panel-close');
        if (catPanelClose) {
            catPanelClose.addEventListener('click', () => {
                ideaMapState.showCategoryPanel = false;
                ideaMapRenderKanban(el);
            });
        }

        const addCatBtn = el.querySelector('#ideamap-cat-add-btn');
        if (addCatBtn) {
            addCatBtn.addEventListener('click', () => {
                ideaMapState.addingCategory = true;
                ideaMapRenderKanban(el);
            });
        }

        // Add form events
        const addForm = el.querySelector('#ideamap-cat-add-form');
        if (addForm) {
            // Color picker
            addForm.querySelectorAll('.ideamap-cat-color-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    addForm.querySelectorAll('.ideamap-cat-color-btn').forEach(b => b.classList.remove('selected'));
                    btn.classList.add('selected');
                });
            });
            const addSave = addForm.querySelector('#ideamap-cat-add-save');
            if (addSave) addSave.addEventListener('click', () => {
                const name = addForm.querySelector('#ideamap-cat-add-name').value.trim();
                if (!name) return;
                const color = addForm.querySelector('.ideamap-cat-color-btn.selected')?.dataset.color || IDEAMAP_PRESET_COLORS[0];
                const parentId = addForm.querySelector('#ideamap-cat-add-parent').value || null;
                const cats = ideaMapGetCategories();
                cats.push({ id: ideaMapGenId(), name, parentId, color });
                ideaMapSaveCategories(cats);
                ideaMapState.addingCategory = false;
                ideaMapRenderKanban(el);
            });
            const addCancel = addForm.querySelector('#ideamap-cat-add-cancel');
            if (addCancel) addCancel.addEventListener('click', () => {
                ideaMapState.addingCategory = false;
                ideaMapRenderKanban(el);
            });
        }

        // Edit buttons
        el.querySelectorAll('.ideamap-cat-edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                ideaMapState.editingCategoryId = btn.dataset.catId;
                ideaMapRenderKanban(el);
            });
        });

        // Delete buttons
        el.querySelectorAll('.ideamap-cat-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const catId = btn.dataset.catId;
                let cats = ideaMapGetCategories();
                // Remove this cat and its children
                const toRemove = [catId, ...cats.filter(c => c.parentId === catId).map(c => c.id)];
                cats = cats.filter(c => !toRemove.includes(c.id));
                ideaMapSaveCategories(cats);
                // Remove idea mappings
                const mapping = ideaMapGetIdeaCategories();
                for (const key of Object.keys(mapping)) {
                    if (toRemove.includes(mapping[key])) delete mapping[key];
                }
                ideaMapSaveIdeaCategories(mapping);
                ideaMapState.editingCategoryId = null;
                ideaMapRenderKanban(el);
            });
        });

        // Edit form save/cancel
        el.querySelectorAll('.ideamap-cat-edit-save').forEach(btn => {
            btn.addEventListener('click', () => {
                const catId = btn.dataset.catId;
                const form = el.querySelector(`.ideamap-cat-edit-form[data-edit-id="${catId}"]`);
                if (!form) return;
                const name = form.querySelector(`#ideamap-cat-edit-name-${catId}`).value.trim();
                if (!name) return;
                const color = form.querySelector('.ideamap-cat-color-btn.selected')?.dataset.color || IDEAMAP_PRESET_COLORS[0];
                const parentId = form.querySelector(`#ideamap-cat-edit-parent-${catId}`).value || null;
                const cats = ideaMapGetCategories();
                const cat = cats.find(c => c.id === catId);
                if (cat) { cat.name = name; cat.color = color; cat.parentId = parentId; }
                ideaMapSaveCategories(cats);
                ideaMapState.editingCategoryId = null;
                ideaMapRenderKanban(el);
            });
        });
        el.querySelectorAll('.ideamap-cat-edit-cancel').forEach(btn => {
            btn.addEventListener('click', () => {
                ideaMapState.editingCategoryId = null;
                ideaMapRenderKanban(el);
            });
        });

        // Edit form color pickers
        el.querySelectorAll('.ideamap-cat-edit-form').forEach(form => {
            form.querySelectorAll('.ideamap-cat-color-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    form.querySelectorAll('.ideamap-cat-color-btn').forEach(b => b.classList.remove('selected'));
                    btn.classList.add('selected');
                });
            });
        });
    }

    function ideaMapShowCardPopover(el, ideaId) {
        const idea = ideaMapState.ideas.find(i => i.id === ideaId);
        if (!idea) return;
        const popover = el.querySelector('#ideamap-popover');
        if (!popover) return;

        const tags = ideaMapGetTags(idea);
        const status = ideaMapGetStatus(idea);
        const cats = ideaMapGetCategories();
        const mapping = ideaMapGetIdeaCategories();
        const currentCatId = mapping[ideaId] || '';
        const topCats = cats.filter(c => !c.parentId);

        // Build category dropdown options with indentation
        let catOptions = `<option value="">Uncategorized</option>`;
        for (const tc of topCats) {
            catOptions += `<option value="${tc.id}" ${currentCatId === tc.id ? 'selected' : ''}>${escHtml(tc.name)}</option>`;
            const children = cats.filter(c => c.parentId === tc.id);
            for (const ch of children) {
                catOptions += `<option value="${ch.id}" ${currentCatId === ch.id ? 'selected' : ''}>&nbsp;&nbsp;&nbsp;${escHtml(ch.name)}</option>`;
            }
        }

        const currentCat = cats.find(c => c.id === currentCatId);
        const catDisplay = currentCat ? escHtml(currentCat.name) : 'Uncategorized';

        popover.innerHTML = `
            <div class="ideamap-popover-header">
                <span class="ideamap-popover-title">${escHtml(idea.name)}</span>
                <button class="ideamap-popover-close" id="ideamap-popover-close">&times;</button>
            </div>
            <label class="ideamap-popover-label">Status</label>
            <select class="ideamap-popover-select" id="ideamap-pop-status">
                <option value="idea" ${status === 'idea' ? 'selected' : ''}>Idea</option>
                <option value="incubator" ${status === 'incubator' ? 'selected' : ''}>Incubator</option>
                <option value="in-progress" ${status === 'in-progress' ? 'selected' : ''}>In Progress</option>
                <option value="converted" ${status === 'converted' || status === 'posted' ? 'selected' : ''}>Posted</option>
            </select>
            <label class="ideamap-popover-label">Category</label>
            <select class="ideamap-popover-select" id="ideamap-pop-category">
                ${catOptions}
            </select>
            <label class="ideamap-popover-label">Tags</label>
            <div class="ideamap-popover-tags">${tags.length ? tags.map(t => `<span class="ideamap-card-tag">${escHtml(t)}</span>`).join('') : '<span style="color:#999">No tags</span>'}</div>
            ${idea.project && ideaMapState.projects && ideaMapState.projects.includes(idea.project) ? `<label class="ideamap-popover-label">Project</label><div style="color:#5a3e1b;font-weight:600;margin-bottom:8px">${escHtml(idea.project)}</div>` : ''}
            ${idea.script ? `<label class="ideamap-popover-label">Notes</label><div class="ideamap-popover-notes">${escHtml(idea.script.substring(0, 300))}${idea.script.length > 300 ? '...' : ''}</div>` : ''}
            <button class="ideamap-popover-save" id="ideamap-pop-save">Save</button>
        `;
        popover.style.display = '';

        popover.querySelector('#ideamap-popover-close').addEventListener('click', () => {
            popover.style.display = 'none';
        });

        popover.querySelector('#ideamap-pop-save').addEventListener('click', async () => {
            const newStatus = popover.querySelector('#ideamap-pop-status').value;
            const newCatId = popover.querySelector('#ideamap-pop-category').value;
            try {
                await NotesService.update(ideaId, {
                    status: newStatus,
                    type: newStatus === 'converted' ? 'converted' : 'idea'
                });
            } catch (e) { /* ignore */ }
            const idx = ideaMapState.ideas.findIndex(i => i.id === ideaId);
            if (idx >= 0) {
                ideaMapState.ideas[idx].status = newStatus;
            }
            // Save category
            const catMapping = ideaMapGetIdeaCategories();
            if (newCatId) { catMapping[ideaId] = newCatId; }
            else { delete catMapping[ideaId]; }
            ideaMapSaveIdeaCategories(catMapping);

            popover.style.display = 'none';
            ideaMapRenderKanban(el);
        });
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
            ideaMapState.projects = null;
            ideaMapState.filterCategory = 'all';
            ideaMapState.expandedCategoryFilter = null;
            ideaMapState.groupBy = 'tag';
            ideaMapState.showCategoryPanel = false;
            ideaMapState.editingCategoryId = null;
            ideaMapState.addingCategory = false;
            ideaMapState.searchQuery = '';
            ideaMapState.searchResults = null;
            ideaMapState.searchLoading = false;
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
