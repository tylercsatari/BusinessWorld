/* ── Gym UI ── full-featured workout tracker ── */
const GymUI = (() => {
    let container = null;
    let activeTab = 'dashboard';
    let activePlayer = 'tyler';
    let selectedRoutineId = null;
    let logState = { feeling: 3, notes: '', calories: '', sets: {} };
    let progressMetric = 'weight';
    let editingRoutineId = null;

    const TABS = [
        { id: 'dashboard', icon: '\u{1F3E0}', label: 'Dashboard' },
        { id: 'log',       icon: '\u{1F4AA}', label: 'Log Workout' },
        { id: 'progress',  icon: '\u{1F4C8}', label: 'Progress' },
        { id: 'routines',  icon: '\u{1F4CB}', label: 'Routines' },
        { id: 'body',      icon: '\u2696\uFE0F', label: 'Body' }
    ];

    const FEELING_EMOJIS = ['\u{1F629}', '\u{1F615}', '\u{1F610}', '\u{1F60A}', '\u{1F525}'];
    const CATEGORY_ICONS = { push: '\u2B06', pull: '\u2B07', legs: '\u{1F9B5}', core: '\u{1F3AF}' };

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    function today() { return new Date().toISOString().slice(0, 10); }

    function fmtDate(d) {
        const dt = new Date(d);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    function fmtNumber(n) {
        return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    }

    function showToast(msg) {
        const t = document.createElement('div');
        t.className = 'gym-toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2000);
    }

    /* ── SVG Charts ── */
    function renderSparkline(values, w, h) {
        w = w || 200; h = h || 40;
        if (values.length < 2) return '<div class="gym-empty">Not enough data</div>';
        const min = Math.min(...values);
        const max = Math.max(...values);
        const range = max - min || 1;
        const pad = 2;
        const pts = values.map((v, i) => {
            const x = pad + (i / (values.length - 1)) * (w - pad * 2);
            const y = h - pad - ((v - min) / range) * (h - pad * 2);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        });
        const lastX = pad + ((values.length - 1) / (values.length - 1)) * (w - pad * 2);
        const lastY = h - pad - ((values[values.length - 1] - min) / range) * (h - pad * 2);
        return `<svg width="${w}" height="${h}" class="gym-sparkline" viewBox="0 0 ${w} ${h}">
            <polyline points="${pts.join(' ')}" fill="none" stroke="#0984e3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3" fill="#0984e3"/>
        </svg>`;
    }

    function renderLineChart(dataPoints, w, h, label) {
        w = w || 600; h = h || 220;
        if (dataPoints.length < 2) return '<div class="gym-empty">Not enough data for chart</div>';
        const values = dataPoints.map(d => d.value);
        const min = Math.min(...values);
        const max = Math.max(...values);
        const range = max - min || 1;
        const padL = 45, padR = 10, padT = 15, padB = 30;
        const cw = w - padL - padR, ch = h - padT - padB;

        // Grid lines
        let gridLines = '';
        const steps = 4;
        for (let i = 0; i <= steps; i++) {
            const y = padT + (i / steps) * ch;
            const val = max - (i / steps) * range;
            gridLines += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="#282828" stroke-width="1"/>`;
            gridLines += `<text x="${padL - 6}" y="${y + 4}" fill="#555" font-size="10" text-anchor="end">${Math.round(val)}</text>`;
        }

        // Data line
        const pts = dataPoints.map((d, i) => {
            const x = padL + (i / (dataPoints.length - 1)) * cw;
            const y = padT + ((max - d.value) / range) * ch;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        });

        // X-axis labels (show up to 6)
        let xLabels = '';
        const labelStep = Math.max(1, Math.floor(dataPoints.length / 6));
        dataPoints.forEach((d, i) => {
            if (i % labelStep === 0 || i === dataPoints.length - 1) {
                const x = padL + (i / (dataPoints.length - 1)) * cw;
                xLabels += `<text x="${x}" y="${h - 5}" fill="#555" font-size="10" text-anchor="middle">${fmtDate(d.date)}</text>`;
            }
        });

        // Dots
        let dots = '';
        dataPoints.forEach((d, i) => {
            const x = padL + (i / (dataPoints.length - 1)) * cw;
            const y = padT + ((max - d.value) / range) * ch;
            dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="#0984e3"/>`;
        });

        return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
            ${gridLines}
            <polyline points="${pts.join(' ')}" fill="none" stroke="#0984e3" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            ${dots}
            ${xLabels}
            ${label ? `<text x="${w / 2}" y="12" fill="#666" font-size="11" text-anchor="middle">${esc(label)}</text>` : ''}
        </svg>`;
    }

    /* ── Render Functions ── */
    function renderPlayerChips() {
        return GymService.getPlayers().map(p =>
            `<div class="gym-player-chip ${p.id === activePlayer ? 'active' : ''}" data-player="${esc(p.id)}">${p.avatar} ${esc(p.name)}</div>`
        ).join('');
    }

    function renderTabs() {
        return TABS.map(t =>
            `<button class="gym-tab ${t.id === activeTab ? 'active' : ''}" data-tab="${t.id}">${t.icon} ${t.label}</button>`
        ).join('');
    }

    /* ── Dashboard Tab ── */
    function renderDashboard() {
        const pid = activePlayer;
        const nextRoutineId = GymService.getNextRoutine(pid);
        const nextRoutine = GymService.getRoutine(nextRoutineId);
        const weights = GymService.getWeights(pid);
        const currentWeight = weights.length ? weights[weights.length - 1].value : '—';
        const thisWeek = GymService.getWorkoutsThisWeek(pid);
        const total = GymService.getTotalWorkouts(pid);
        const recent = GymService.getWorkouts(pid, 5);

        const bestBench = GymService.getBestLift(pid, 'bench_press');
        const bestSquat = GymService.getBestLift(pid, 'back_squat');

        let html = `
            <button class="gym-start-btn" data-action="start-workout" data-routine="${nextRoutineId}">
                Start Workout
                <div class="gym-start-sub">Next up: ${nextRoutine ? esc(nextRoutine.name) + ' — ' + esc(nextRoutine.description) : 'Select a routine'}</div>
            </button>
            <div class="gym-quick-stats">
                <div class="gym-stat-card"><div class="gym-stat-value">${currentWeight === '—' ? '—' : currentWeight + ' lb'}</div><div class="gym-stat-label">Weight</div></div>
                <div class="gym-stat-card"><div class="gym-stat-value">${thisWeek}</div><div class="gym-stat-label">This Week</div></div>
                <div class="gym-stat-card"><div class="gym-stat-value">${total}</div><div class="gym-stat-label">Total Workouts</div></div>
                <div class="gym-stat-card"><div class="gym-stat-value">${bestBench ? bestBench.weight + ' lb' : '—'}</div><div class="gym-stat-label">Best Bench</div></div>
                <div class="gym-stat-card"><div class="gym-stat-value">${bestSquat ? bestSquat.weight + ' lb' : '—'}</div><div class="gym-stat-label">Best Squat</div></div>
            </div>`;

        if (weights.length >= 2) {
            html += `<div class="gym-recent-title">Weight Trend</div>`;
            html += renderSparkline(weights.slice(-10).map(w => w.value), 320, 50);
        }

        html += `<div class="gym-recent-title">Recent Workouts</div>`;
        if (recent.length === 0) {
            html += '<div class="gym-empty">No workouts yet. Hit that start button!</div>';
        } else {
            html += '<div class="gym-recent-list">';
            recent.forEach(w => {
                const r = GymService.getRoutine(w.routineId);
                const vol = GymService.getWorkoutVolume(w);
                html += `<div class="gym-recent-item">
                    <span class="gym-recent-date">${fmtDate(w.date)}</span>
                    <span class="gym-recent-name">${r ? esc(r.name) : 'Custom'}</span>
                    <span class="gym-recent-vol">${fmtNumber(vol)} vol</span>
                </div>`;
            });
            html += '</div>';
        }
        return html;
    }

    /* ── Log Workout Tab ── */
    function renderLogWorkout() {
        const pid = activePlayer;
        const routines = GymService.getRoutines();
        let html = '<div class="gym-routine-cards">';
        routines.forEach(r => {
            html += `<div class="gym-routine-card ${selectedRoutineId === r.id ? 'selected' : ''}" data-routine="${esc(r.id)}">
                <div class="gym-routine-card-name">${esc(r.name)}</div>
                <div class="gym-routine-card-desc">${esc(r.description)}</div>
            </div>`;
        });
        html += '</div>';

        if (selectedRoutineId) {
            const routine = GymService.getRoutine(selectedRoutineId);
            if (routine) {
                html += '<div class="gym-exercise-list">';
                routine.exercises.forEach((re, reIdx) => {
                    const exDef = GymService.getExercise(re.exerciseId);
                    if (!exDef) return;
                    const prog = GymService.getProgressionSuggestion(pid, re.exerciseId);
                    const lastW = GymService.getLastWeight(pid, re.exerciseId);
                    const history = GymService.getExerciseHistory(pid, re.exerciseId, 3);
                    const suggestedWeight = prog.suggest ? prog.weight : (lastW || re.defaultWeight || 0);

                    html += `<div class="gym-exercise-row" data-exercise-idx="${reIdx}">
                        <div class="gym-exercise-header">
                            <span class="gym-exercise-name">${esc(exDef.name)}
                                <span class="gym-category-icon ${exDef.category}">${CATEGORY_ICONS[exDef.category] || ''} ${exDef.category}</span>
                            </span>
                            ${prog.suggest
                                ? `<span class="gym-progression-badge up">\u2191 Try ${prog.weight}lb</span>`
                                : (lastW ? `<span class="gym-progression-badge keep">Keep at ${lastW}lb</span>` : '')}
                        </div>
                        <div class="gym-set-rows">`;

                    for (let s = 0; s < re.sets; s++) {
                        const setKey = `${reIdx}-${s}`;
                        const saved = logState.sets[setKey] || {};
                        const w = saved.weight !== undefined ? saved.weight : suggestedWeight;
                        const r2 = saved.reps !== undefined ? saved.reps : '';
                        const done = saved.completed || false;
                        html += `<div class="gym-set-row">
                            <span class="gym-set-label">S${s + 1}</span>
                            <input type="number" class="gym-set-input gym-set-weight" data-set="${setKey}" value="${w}" placeholder="lb">
                            <span class="gym-set-x">\u00D7</span>
                            <input type="number" class="gym-set-input gym-set-reps" data-set="${setKey}" value="${r2}" placeholder="reps">
                            <button class="gym-set-check ${done ? 'done' : ''}" data-set="${setKey}">\u2713</button>
                        </div>`;
                    }

                    html += '</div>';

                    if (history.length > 0) {
                        html += '<div class="gym-exercise-history">Last: ';
                        history.forEach(h => {
                            html += `<span>${h.weight}lb (${fmtDate(h.date)})</span>`;
                        });
                        html += '</div>';
                    }

                    html += '</div>';
                });
                html += '</div>';

                // Bottom bar
                html += `<div class="gym-log-bottom">
                    <div class="gym-feeling-picker">`;
                FEELING_EMOJIS.forEach((em, i) => {
                    html += `<button class="gym-feeling-btn ${logState.feeling === (i + 1) ? 'active' : ''}" data-feeling="${i + 1}">${em}</button>`;
                });
                html += `</div>
                    <textarea class="gym-log-notes" placeholder="Notes..." data-field="notes">${esc(logState.notes)}</textarea>
                    <input type="number" class="gym-log-calories" placeholder="kcal" data-field="calories" value="${esc(logState.calories)}">
                    <button class="gym-save-btn" data-action="save-workout">Save Workout</button>
                </div>`;
            }
        }
        return html;
    }

    /* ── Progress Tab ── */
    function renderProgress() {
        const pid = activePlayer;
        const exercises = GymService.getExercises();
        let html = `<select class="gym-metric-select" data-action="change-metric">
            <option value="weight" ${progressMetric === 'weight' ? 'selected' : ''}>Bodyweight</option>`;
        exercises.forEach(e => {
            html += `<option value="${esc(e.id)}" ${progressMetric === e.id ? 'selected' : ''}>${esc(e.name)}</option>`;
        });
        html += '</select>';

        html += '<div class="gym-chart-container">';
        if (progressMetric === 'weight') {
            const weights = GymService.getWeights(pid);
            if (weights.length >= 2) {
                html += renderLineChart(weights, 600, 220, 'Bodyweight (lb)');
            } else {
                html += '<div class="gym-empty">Log at least 2 weight entries to see a chart</div>';
            }
        } else {
            const progression = GymService.getExerciseProgression(pid, progressMetric);
            const exDef = GymService.getExercise(progressMetric);
            if (progression.length >= 2) {
                html += renderLineChart(progression, 600, 220, (exDef ? exDef.name : '') + ' (lb)');
            } else {
                html += '<div class="gym-empty">Log at least 2 sessions to see progression</div>';
            }
        }
        html += '</div>';

        // PRs
        if (progressMetric !== 'weight') {
            const prs = GymService.getPRs(pid, progressMetric);
            if (prs.length > 0) {
                html += '<div class="gym-pr-section"><div class="gym-recent-title">Personal Records</div>';
                prs.forEach((pr, i) => {
                    const medal = i === 0 ? '\u{1F947}' : i === 1 ? '\u{1F948}' : '\u{1F949}';
                    html += `<span class="gym-pr-badge">${medal} ${pr.weight}lb \u00D7 ${pr.reps} — ${fmtDate(pr.date)}</span>`;
                });
                html += '</div>';
            }
        }

        // Challenges
        html += `<div class="gym-recent-title" style="margin-top:20px">Challenges</div>
            <button class="gym-add-btn" data-action="add-challenge">+ Add Challenge</button>`;
        const challenges = GymService.getChallenges(pid);
        if (challenges.length > 0) {
            html += '<div class="gym-challenge-list">';
            challenges.forEach(c => {
                html += `<div class="gym-challenge-item">
                    <span class="gym-challenge-name">${esc(c.name)}</span>
                    <span class="gym-challenge-val">${esc(String(c.value))} ${esc(c.unit)}</span>
                    <span class="gym-challenge-date">${fmtDate(c.date)}</span>
                </div>`;
            });
            html += '</div>';
        }
        return html;
    }

    /* ── Routines Tab ── */
    function renderRoutines() {
        const routines = GymService.getRoutines();
        const settings = GymService.getSettings();
        let html = '<button class="gym-add-btn" data-action="add-routine" style="margin-bottom:12px">+ New Routine</button>';

        routines.forEach(r => {
            const isEditing = editingRoutineId === r.id;
            html += `<div class="gym-routine-detail">
                <div class="gym-routine-detail-header">
                    <div>
                        <div class="gym-routine-detail-name">${esc(r.name)}</div>
                        <div class="gym-routine-detail-desc">${esc(r.description)}</div>
                    </div>
                    <div style="display:flex;gap:4px;">
                        <button class="gym-icon-btn" data-action="edit-routine" data-routine="${esc(r.id)}" title="Edit">\u270F</button>
                        <button class="gym-icon-btn" data-action="delete-routine" data-routine="${esc(r.id)}" title="Delete">\u2715</button>
                    </div>
                </div>
                <div class="gym-routine-exercises">`;
            r.exercises.forEach((re, i) => {
                const exDef = GymService.getExercise(re.exerciseId);
                html += `<div class="gym-routine-exercise-row">
                    <span class="gym-routine-exercise-name">${exDef ? esc(exDef.name) : esc(re.exerciseId)}</span>
                    <span class="gym-routine-exercise-detail">${re.sets} sets @ ${re.defaultWeight}lb</span>
                </div>`;
            });
            html += '</div>';
            if (isEditing) {
                html += renderRoutineEditor(r);
            }
            html += '</div>';
        });

        html += `<div class="gym-settings-section">
            <div class="gym-recent-title">Settings</div>
            <div class="gym-settings-row">
                <span class="gym-settings-label">Rep Range Min</span>
                <input type="number" class="gym-settings-input" data-setting="repRangeMin" value="${settings.repRangeMin}">
            </div>
            <div class="gym-settings-row">
                <span class="gym-settings-label">Rep Range Max</span>
                <input type="number" class="gym-settings-input" data-setting="repRangeMax" value="${settings.repRangeMax}">
            </div>
            <div class="gym-settings-row">
                <span class="gym-settings-label">Default Sets</span>
                <input type="number" class="gym-settings-input" data-setting="defaultSets" value="${settings.defaultSets}">
            </div>
        </div>`;

        return html;
    }

    function renderRoutineEditor(routine) {
        const allExercises = GymService.getExercises();
        let html = `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #282828">
            <div class="gym-inline-form">
                <input type="text" class="gym-diet-input name" placeholder="Routine name" value="${esc(routine.name)}" data-edit="name">
                <input type="text" class="gym-diet-input name" placeholder="Description" value="${esc(routine.description)}" data-edit="description">
                <button class="gym-save-btn" data-action="save-routine-edit" data-routine="${esc(routine.id)}">Save</button>
            </div>
            <div style="margin-top:6px">
                <select class="gym-metric-select" data-action="add-exercise-to-routine" data-routine="${esc(routine.id)}">
                    <option value="">+ Add exercise...</option>`;
        allExercises.forEach(e => {
            html += `<option value="${esc(e.id)}">${esc(e.name)}</option>`;
        });
        html += `</select>
            </div>
        </div>`;
        return html;
    }

    /* ── Body Tab ── */
    function renderBody() {
        const pid = activePlayer;
        let html = '';

        // Weight section
        html += `<div class="gym-body-section">
            <div class="gym-body-section-title">Log Weight</div>
            <div class="gym-weight-form">
                <input type="number" class="gym-weight-input" id="gym-weight-val" placeholder="lbs" step="0.1">
                <input type="date" class="gym-date-input" id="gym-weight-date" value="${today()}">
                <button class="gym-save-btn" data-action="save-weight">Save</button>
            </div>`;

        const weights = GymService.getWeights(pid);
        if (weights.length > 0) {
            html += '<table class="gym-weight-table"><thead><tr><th>Date</th><th>Weight</th></tr></thead><tbody>';
            weights.slice(-20).reverse().forEach(w => {
                html += `<tr><td>${fmtDate(w.date)}</td><td>${w.value} lb</td></tr>`;
            });
            html += '</tbody></table>';
        }
        html += '</div>';

        // Photo section
        html += `<div class="gym-body-section">
            <div class="gym-body-section-title">Progress Photos</div>
            <div class="gym-photo-upload">
                <input type="file" accept="image/*" id="gym-photo-input" style="display:none">
                <button class="gym-add-btn" data-action="upload-photo">+ Upload Photo</button>
                <input type="date" class="gym-date-input" id="gym-photo-date" value="${today()}">
            </div>`;

        const photos = GymService.getPhotos(pid);
        if (photos.length > 0) {
            html += '<div class="gym-photo-gallery">';
            photos.slice().reverse().forEach(p => {
                html += `<div class="gym-photo-card">
                    <img src="${p.url}" alt="Progress photo">
                    <div class="gym-photo-card-date">${fmtDate(p.date)}</div>
                </div>`;
            });
            html += '</div>';
        }
        html += '</div>';

        // Diet section
        html += `<div class="gym-body-section">
            <div class="gym-body-section-title">Diet Log</div>
            <div class="gym-diet-form">
                <input type="text" class="gym-diet-input name" id="gym-diet-name" placeholder="Food item">
                <input type="number" class="gym-diet-input num" id="gym-diet-cal" placeholder="kcal">
                <input type="number" class="gym-diet-input num" id="gym-diet-protein" placeholder="prot">
                <input type="number" class="gym-diet-input num" id="gym-diet-carbs" placeholder="carbs">
                <input type="number" class="gym-diet-input num" id="gym-diet-fat" placeholder="fat">
                <button class="gym-save-btn" data-action="save-diet">Add</button>
            </div>`;

        const dietEntries = GymService.getDiet(pid);
        const todayDiet = dietEntries.filter(d => d.date === today());
        if (todayDiet.length > 0) {
            let totalCal = 0, totalP = 0, totalC = 0, totalF = 0;
            todayDiet.forEach(d => {
                (d.items || []).forEach(item => {
                    totalCal += item.calories || 0;
                    totalP += item.protein || 0;
                    totalC += item.carbs || 0;
                    totalF += item.fat || 0;
                });
            });
            html += `<div class="gym-diet-summary">
                <div class="gym-diet-stat"><div class="gym-diet-stat-val">${totalCal}</div><div class="gym-diet-stat-label">Calories</div></div>
                <div class="gym-diet-stat"><div class="gym-diet-stat-val">${totalP}g</div><div class="gym-diet-stat-label">Protein</div></div>
                <div class="gym-diet-stat"><div class="gym-diet-stat-val">${totalC}g</div><div class="gym-diet-stat-label">Carbs</div></div>
                <div class="gym-diet-stat"><div class="gym-diet-stat-val">${totalF}g</div><div class="gym-diet-stat-label">Fat</div></div>
            </div>
            <div class="gym-diet-items">`;
            todayDiet.forEach(d => {
                (d.items || []).forEach(item => {
                    html += `<div class="gym-diet-item">
                        <span class="gym-diet-item-name">${esc(item.name)}</span>
                        <span class="gym-diet-item-macros">${item.calories}cal ${item.protein}p ${item.carbs}c ${item.fat}f</span>
                    </div>`;
                });
            });
            html += '</div>';
        }
        html += '</div>';
        return html;
    }

    /* ── Main Render ── */
    function render() {
        return `<div class="gym-panel">
            <div class="gym-header">
                <h2>\u{1F3CB}\u{FE0F} Gym</h2>
                <div class="gym-player-chips">${renderPlayerChips()}</div>
            </div>
            <div class="gym-tabs">${renderTabs()}</div>
            <div class="gym-tab-content" id="gym-tab-content"></div>
        </div>`;
    }

    function renderActiveTab() {
        const el = container && container.querySelector('#gym-tab-content');
        if (!el) return;
        switch (activeTab) {
            case 'dashboard': el.innerHTML = renderDashboard(); break;
            case 'log':       el.innerHTML = renderLogWorkout(); break;
            case 'progress':  el.innerHTML = renderProgress(); break;
            case 'routines':  el.innerHTML = renderRoutines(); break;
            case 'body':      el.innerHTML = renderBody(); break;
        }
        bindTabEvents();
    }

    /* ── Event Binding ── */
    function bindEvents() {
        if (!container) return;

        // Tab switching
        container.querySelectorAll('.gym-tab').forEach(el => {
            el.addEventListener('click', () => {
                activeTab = el.dataset.tab;
                container.querySelectorAll('.gym-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
                renderActiveTab();
            });
        });

        // Player switching
        container.querySelectorAll('.gym-player-chip').forEach(el => {
            el.addEventListener('click', () => {
                activePlayer = el.dataset.player;
                container.querySelectorAll('.gym-player-chip').forEach(c => c.classList.toggle('active', c.dataset.player === activePlayer));
                renderActiveTab();
            });
        });

        renderActiveTab();
    }

    function bindTabEvents() {
        if (!container) return;
        const content = container.querySelector('#gym-tab-content');
        if (!content) return;

        // Dashboard: start workout button
        content.querySelectorAll('[data-action="start-workout"]').forEach(el => {
            el.addEventListener('click', () => {
                selectedRoutineId = el.dataset.routine;
                activeTab = 'log';
                container.querySelectorAll('.gym-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'log'));
                logState = { feeling: 3, notes: '', calories: '', sets: {} };
                renderActiveTab();
            });
        });

        // Log: routine selection
        content.querySelectorAll('.gym-routine-card').forEach(el => {
            el.addEventListener('click', () => {
                selectedRoutineId = el.dataset.routine;
                logState = { feeling: 3, notes: '', calories: '', sets: {} };
                renderActiveTab();
            });
        });

        // Log: set inputs
        content.querySelectorAll('.gym-set-weight').forEach(el => {
            el.addEventListener('input', () => {
                const key = el.dataset.set;
                if (!logState.sets[key]) logState.sets[key] = {};
                logState.sets[key].weight = parseFloat(el.value) || 0;
            });
        });
        content.querySelectorAll('.gym-set-reps').forEach(el => {
            el.addEventListener('input', () => {
                const key = el.dataset.set;
                if (!logState.sets[key]) logState.sets[key] = {};
                logState.sets[key].reps = parseInt(el.value) || 0;
            });
        });
        content.querySelectorAll('.gym-set-check').forEach(el => {
            el.addEventListener('click', () => {
                const key = el.dataset.set;
                if (!logState.sets[key]) logState.sets[key] = {};
                logState.sets[key].completed = !logState.sets[key].completed;
                el.classList.toggle('done', logState.sets[key].completed);
            });
        });

        // Log: feeling picker
        content.querySelectorAll('.gym-feeling-btn').forEach(el => {
            el.addEventListener('click', () => {
                logState.feeling = parseInt(el.dataset.feeling);
                content.querySelectorAll('.gym-feeling-btn').forEach(b => b.classList.toggle('active', b.dataset.feeling === el.dataset.feeling));
            });
        });

        // Log: notes & calories
        const notesEl = content.querySelector('[data-field="notes"]');
        if (notesEl) notesEl.addEventListener('input', () => { logState.notes = notesEl.value; });
        const calEl = content.querySelector('[data-field="calories"]');
        if (calEl) calEl.addEventListener('input', () => { logState.calories = calEl.value; });

        // Log: save workout
        content.querySelectorAll('[data-action="save-workout"]').forEach(el => {
            el.addEventListener('click', saveWorkout);
        });

        // Progress: metric change
        const metricSel = content.querySelector('[data-action="change-metric"]');
        if (metricSel) {
            metricSel.addEventListener('change', () => {
                progressMetric = metricSel.value;
                renderActiveTab();
            });
        }

        // Progress: add challenge
        content.querySelectorAll('[data-action="add-challenge"]').forEach(el => {
            el.addEventListener('click', promptAddChallenge);
        });

        // Routines: edit
        content.querySelectorAll('[data-action="edit-routine"]').forEach(el => {
            el.addEventListener('click', () => {
                editingRoutineId = editingRoutineId === el.dataset.routine ? null : el.dataset.routine;
                renderActiveTab();
            });
        });

        // Routines: delete
        content.querySelectorAll('[data-action="delete-routine"]').forEach(el => {
            el.addEventListener('click', () => {
                if (confirm('Delete this routine?')) {
                    GymService.deleteRoutine(el.dataset.routine);
                    renderActiveTab();
                }
            });
        });

        // Routines: save edit
        content.querySelectorAll('[data-action="save-routine-edit"]').forEach(el => {
            el.addEventListener('click', () => {
                const rid = el.dataset.routine;
                const routine = GymService.getRoutine(rid);
                if (!routine) return;
                const nameInput = content.querySelector('[data-edit="name"]');
                const descInput = content.querySelector('[data-edit="description"]');
                if (nameInput) routine.name = nameInput.value;
                if (descInput) routine.description = descInput.value;
                GymService.updateRoutine(rid, routine);
                editingRoutineId = null;
                renderActiveTab();
                showToast('Routine saved');
            });
        });

        // Routines: add exercise to routine
        content.querySelectorAll('[data-action="add-exercise-to-routine"]').forEach(sel => {
            sel.addEventListener('change', () => {
                if (!sel.value) return;
                const rid = sel.dataset.routine;
                const routine = GymService.getRoutine(rid);
                if (!routine) return;
                const settings = GymService.getSettings();
                routine.exercises.push({ exerciseId: sel.value, sets: settings.defaultSets, defaultWeight: 0 });
                GymService.updateRoutine(rid, routine);
                renderActiveTab();
            });
        });

        // Routines: add new routine
        content.querySelectorAll('[data-action="add-routine"]').forEach(el => {
            el.addEventListener('click', () => {
                const name = prompt('Routine name:');
                if (!name) return;
                const desc = prompt('Description:') || '';
                const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now();
                GymService.addRoutine({ id, name, description: desc, exercises: [] });
                editingRoutineId = id;
                renderActiveTab();
            });
        });

        // Routines: settings
        content.querySelectorAll('.gym-settings-input[data-setting]').forEach(el => {
            el.addEventListener('change', () => {
                const obj = {};
                obj[el.dataset.setting] = parseInt(el.value) || 0;
                GymService.updateSettings(obj);
            });
        });

        // Body: save weight
        content.querySelectorAll('[data-action="save-weight"]').forEach(el => {
            el.addEventListener('click', () => {
                const val = document.getElementById('gym-weight-val');
                const date = document.getElementById('gym-weight-date');
                if (!val || !val.value) return;
                GymService.logWeight(activePlayer, date ? date.value : today(), val.value);
                showToast('Weight logged');
                renderActiveTab();
            });
        });

        // Body: upload photo
        content.querySelectorAll('[data-action="upload-photo"]').forEach(el => {
            el.addEventListener('click', () => {
                const input = document.getElementById('gym-photo-input');
                if (input) input.click();
            });
        });
        const photoInput = document.getElementById('gym-photo-input');
        if (photoInput) {
            photoInput.addEventListener('change', handlePhotoUpload);
        }

        // Body: save diet
        content.querySelectorAll('[data-action="save-diet"]').forEach(el => {
            el.addEventListener('click', saveDietItem);
        });
    }

    /* ── Actions ── */
    function saveWorkout() {
        if (!selectedRoutineId) return;
        const routine = GymService.getRoutine(selectedRoutineId);
        if (!routine) return;

        const exercises = routine.exercises.map((re, reIdx) => {
            const sets = [];
            for (let s = 0; s < re.sets; s++) {
                const key = `${reIdx}-${s}`;
                const saved = logState.sets[key] || {};
                // Read current input values from DOM as fallback
                const weightInput = container.querySelector(`.gym-set-weight[data-set="${key}"]`);
                const repsInput = container.querySelector(`.gym-set-reps[data-set="${key}"]`);
                sets.push({
                    weight: saved.weight !== undefined ? saved.weight : (weightInput ? parseFloat(weightInput.value) || 0 : re.defaultWeight || 0),
                    reps: saved.reps !== undefined ? saved.reps : (repsInput ? parseInt(repsInput.value) || 0 : 0),
                    completed: saved.completed || false
                });
            }
            return { exerciseId: re.exerciseId, sets };
        });

        const workout = {
            date: today(),
            routineId: selectedRoutineId,
            exercises,
            notes: logState.notes,
            feeling: logState.feeling,
            calories: parseInt(logState.calories) || 0
        };

        GymService.logWorkout(activePlayer, workout);
        logState = { feeling: 3, notes: '', calories: '', sets: {} };
        showToast('Workout saved!');
        activeTab = 'dashboard';
        container.querySelectorAll('.gym-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'dashboard'));
        renderActiveTab();
    }

    function promptAddChallenge() {
        const name = prompt('Challenge name:');
        if (!name) return;
        const value = prompt('Value (number):');
        if (!value) return;
        const unit = prompt('Unit (e.g., lb, reps, minutes):') || '';
        GymService.addChallenge(activePlayer, {
            name, value: parseFloat(value) || 0, unit, date: today()
        });
        renderActiveTab();
    }

    function handlePhotoUpload() {
        const input = document.getElementById('gym-photo-input');
        if (!input || !input.files || !input.files[0]) return;
        const file = input.files[0];
        const dateInput = document.getElementById('gym-photo-date');
        const date = dateInput ? dateInput.value : today();

        const reader = new FileReader();
        reader.onload = function (e) {
            // Resize to max 800px wide
            const img = new Image();
            img.onload = function () {
                const maxW = 800;
                let w = img.width, h = img.height;
                if (w > maxW) { h = (h * maxW) / w; w = maxW; }
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
                GymService.addPhoto(activePlayer, { date, url: dataUrl });
                showToast('Photo added');
                renderActiveTab();
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    function saveDietItem() {
        const name = document.getElementById('gym-diet-name');
        const cal = document.getElementById('gym-diet-cal');
        const prot = document.getElementById('gym-diet-protein');
        const carbs = document.getElementById('gym-diet-carbs');
        const fat = document.getElementById('gym-diet-fat');
        if (!name || !name.value) return;

        const item = {
            name: name.value,
            calories: parseInt(cal && cal.value) || 0,
            protein: parseInt(prot && prot.value) || 0,
            carbs: parseInt(carbs && carbs.value) || 0,
            fat: parseInt(fat && fat.value) || 0
        };

        // Find today's diet entry or create one
        const pid = activePlayer;
        const dietEntries = GymService.getDiet(pid);
        const todayEntry = dietEntries.find(d => d.date === today());
        if (todayEntry) {
            todayEntry.items.push(item);
            GymService.save();
        } else {
            GymService.logDiet(pid, { date: today(), items: [item] });
        }

        showToast('Food logged');
        renderActiveTab();
    }

    /* ── Public API ── */
    return {
        open(bodyEl) {
            container = bodyEl;
            GymService.load();
            container.innerHTML = render();
            bindEvents();
        },
        close() {
            container = null;
            activeTab = 'dashboard';
            selectedRoutineId = null;
            logState = { feeling: 3, notes: '', calories: '', sets: {} };
            editingRoutineId = null;
        }
    };
})();

BuildingRegistry.register('Gym', {
    open: (bodyEl, opts) => GymUI.open(bodyEl, opts),
    close: () => GymUI.close()
});
