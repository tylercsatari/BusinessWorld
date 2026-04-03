/* ── Gym UI ── BusinessWorld Warm Aesthetic ── v4 ── */
const GymUI = (() => {
    let container = null;
    let activeTab = 'dashboard';
    let activePlayer = 'tyler';
    let selectedRoutineId = null;
    let trainStep = 'choose'; // 'choose' | 'preview' | 'workout' | 'program'
    let logState = { notes: '', sets: {}, exerciseNotes: {}, additions: [] };
    let editingRoutineId = null;
    let workoutStartTime = null;
    let timerInterval = null;
    let gymCharacterRenderer = null;
    let characterAnimFrame = null;
    let showLevelTooltip = false;
    let showPlayerSwitcher = false;
    let showMealForm = false;
    let mealFormPrefill = null;
    let nutritionDate = null; // set to today() on init
    let showExNotes = {}; // exerciseIdx -> bool

    // Rest timer state
    let restTimerStart = null;
    let restTimerKey = null;
    let restTimerInterval = null;
    let recordedRests = {};

    const ROUTINE_COLORS = { upper1: 'gold', lower1: 'blue', upper2: 'green', lower2: 'red' };
    const ROUTINE_COLOR_HEX = { upper1: '#e8a020', lower1: '#0984e3', upper2: '#2ecc71', lower2: '#e74c3c' };

    /* ── SVG Tab Icons ── */
    const TAB_ICONS = {
        dashboard: '<svg viewBox="0 0 24 24"><path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4"/></svg>',
        train:     '<svg viewBox="0 0 24 24"><path d="M6.5 6.5h11M6.5 17.5h11M4 6.5a2.5 2.5 0 110 5M4 12.5a2.5 2.5 0 100 5M20 6.5a2.5 2.5 0 100 5M20 12.5a2.5 2.5 0 110 5M12 4v16"/></svg>',
        body:      '<svg viewBox="0 0 24 24"><path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>',
        nutrition: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>'
    };

    const TABS = [
        { id: 'dashboard', label: 'Dashboard' },
        { id: 'train',     label: 'Train' },
        { id: 'body',      label: 'Body' },
        { id: 'nutrition',  label: 'Nutrition' }
    ];

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function today() { return new Date().toISOString().slice(0, 10); }
    function fmtDate(d) {
        const dt = new Date(d);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    function relativeDate(d) {
        const now = new Date(); now.setHours(0,0,0,0);
        const dt = new Date(d); dt.setHours(0,0,0,0);
        const diff = Math.round((now - dt) / 86400000);
        if (diff === 0) return 'Today';
        if (diff === 1) return 'Yesterday';
        if (diff < 7) return diff + ' days ago';
        return fmtDate(d);
    }
    function fmtVolume(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return String(n);
    }
    function fmtTimer(ms) {
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    }
    function fmtRestTime(seconds) {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return m + ':' + String(s).padStart(2, '0');
    }
    function showToast(msg) {
        const t = document.createElement('div');
        t.className = 'gym-toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2200);
    }
    function playerColorHex(id) {
        const c = GymService.getPlayerColor(id);
        return '#' + c.toString(16).padStart(6, '0');
    }

    /* ── Streak calculation ── */
    function getStreak(playerId) {
        const workouts = GymService.getWorkouts(playerId);
        if (workouts.length === 0) return 0;
        const dates = [...new Set(workouts.map(w => w.date))].sort().reverse();
        let streak = 0;
        const todayStr = today();
        const d = new Date(todayStr);
        for (let i = 0; i < 365; i++) {
            const check = d.toISOString().slice(0, 10);
            if (dates.includes(check)) { streak++; }
            else if (i > 0) { break; }
            d.setDate(d.getDate() - 1);
        }
        return streak;
    }

    function getTotalVolume(playerId) {
        const workouts = GymService.getWorkouts(playerId);
        let total = 0;
        workouts.forEach(w => { total += GymService.getWorkoutVolume(w); });
        return total;
    }

    /* ── 3D Character ── */
    function createGymCharacter(color) {
        color = color || 0x3498db;
        const THREE = window.THREE;
        const g = new THREE.Group();
        const cMat = new THREE.ShaderMaterial({
            uniforms: { uColor: { value: new THREE.Color(color) }, uRim: { value: new THREE.Color(0xffffff) }, uRimPow: { value: 2.5 } },
            vertexShader: 'varying vec3 vN,vV;void main(){vN=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.0);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}',
            fragmentShader: 'uniform vec3 uColor,uRim;uniform float uRimPow;varying vec3 vN,vV;void main(){float rim=1.0-max(0.0,dot(normalize(vN),normalize(vV)));rim=pow(rim,uRimPow)*0.6;vec3 col=uColor+uRim*rim;float NdotL=max(0.0,dot(normalize(vN),normalize(vec3(1,2,1))));col*=0.5+0.5*NdotL;gl_FragColor=vec4(col,1.0);}'
        });
        var body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 1, 16), cMat);
        body.position.y = 0.5; g.add(body);
        var top = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 16, 0, Math.PI*2, 0, Math.PI/2), cMat);
        top.position.y = 1; g.add(top);
        var neck = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 0.2, 12), cMat);
        neck.position.y = 1.2; g.add(neck);
        var head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 20, 20), cMat);
        head.position.y = 1.65; g.add(head);
        var eyeM = new THREE.MeshBasicMaterial({ color: 0x1a1a2e });
        var eyeW = new THREE.MeshBasicMaterial({ color: 0xffffff });
        [[-0.15, 1.72, 0.3],[0.15, 1.72, 0.3]].forEach(function(pos) {
            var ew = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 10), eyeW);
            ew.position.set(pos[0],pos[1],pos[2]); g.add(ew);
            var ep = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 10), eyeM);
            ep.position.set(pos[0],pos[1],pos[2]+0.04); g.add(ep);
            var eh = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 6), eyeW);
            eh.position.set(pos[0]+0.03,pos[1]+0.03,pos[2]+0.08); g.add(eh);
        });
        var baseMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.7), roughness: 0.7 });
        var base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.48, 0.12, 16), baseMat);
        base.position.set(0, 0.06, 0); g.add(base);
        return g;
    }

    function initCharacterCanvas(wrap) {
        if (!window.THREE) {
            wrap.innerHTML = '<div style="color:#999;text-align:center;padding:40px">3D not available</div>';
            return;
        }
        const size = wrap.clientWidth || 280;
        const canvas = document.createElement('canvas');
        canvas.width = size * 2; canvas.height = size * 2;
        canvas.style.width = size + 'px'; canvas.style.height = size + 'px';
        wrap.appendChild(canvas);
        const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
        renderer.setSize(size, size);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setClearColor(0x000000, 0);
        gymCharacterRenderer = renderer;
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
        camera.position.set(0, 1.8, 4.5); camera.lookAt(0, 1, 0);
        scene.add(new THREE.AmbientLight(0xfff0e0, 1.2));
        const dir = new THREE.DirectionalLight(0xfff8f0, 1.5);
        dir.position.set(3, 8, 5); scene.add(dir);
        const charColor = GymService.getPlayerColor(activePlayer);
        const charGroup = createGymCharacter(charColor);
        scene.add(charGroup);
        function animate() {
            characterAnimFrame = requestAnimationFrame(animate);
            charGroup.rotation.y += 0.008;
            renderer.render(scene, camera);
        }
        animate();
    }

    function disposeCharacter() {
        if (characterAnimFrame) { cancelAnimationFrame(characterAnimFrame); characterAnimFrame = null; }
        if (gymCharacterRenderer) { gymCharacterRenderer.dispose(); gymCharacterRenderer = null; }
    }

    function renderTabs() {
        return TABS.map(t =>
            '<button class="gym-tab ' + (t.id === activeTab ? 'active' : '') + '" data-tab="' + t.id + '">' + TAB_ICONS[t.id] + '<span>' + t.label + '</span></button>'
        ).join('');
    }

    /* ══════════════════════════════════════════
       TAB 1: DASHBOARD
    ══════════════════════════════════════════ */
    function renderDashboard() {
        const pid = activePlayer;
        const player = GymService.getPlayer(pid);
        const playerName = player ? player.name : pid;
        const levelInfo = GymService.getPlayerLevel(pid);
        const totalWorkouts = GymService.getTotalWorkouts(pid);
        const weekWorkouts = GymService.getWorkoutsThisWeek(pid);
        const streak = getStreak(pid);
        const totalVol = getTotalVolume(pid);
        const recent = GymService.getWorkouts(pid, 3);
        const weights = GymService.getWeights(pid);
        const currentWeight = weights.length ? weights[weights.length - 1].value : '--';

        let html = '';

        // Character section (single active character)
        html += '<div class="gym-character-section">' +
            '<div class="gym-character-canvas-wrap" id="gym-char-canvas"></div>' +
            '<div class="gym-character-name" data-action="toggle-player-switcher" style="cursor:pointer">' + esc(playerName) +
                ' <span style="font-size:14px;color:var(--gym-text-muted);vertical-align:middle">&#9660;</span>' +
            '</div>' +
        '</div>';

        // Player switcher overlay
        if (showPlayerSwitcher) {
            html += '<div class="gym-player-switcher-overlay">';
            GymService.getPlayers().forEach(p => {
                const hex = playerColorHex(p.id);
                const isActive = p.id === activePlayer;
                html += '<div class="gym-player-switch-card ' + (isActive ? 'active' : '') + '" data-switch-player="' + esc(p.id) + '">' +
                    '<div class="gym-player-switch-avatar" style="background:' + hex + '">' + p.name.charAt(0).toUpperCase() + '</div>' +
                    '<div class="gym-player-switch-name">' + esc(p.name) + '</div>' +
                    (isActive ? '<span class="gym-player-switch-check">&#10003;</span>' : '') +
                '</div>';
            });
            html += '</div>';
        }

        // XP Level section
        html += '<div class="gym-xp-section" data-action="toggle-level-info" style="cursor:pointer">' +
            '<div class="gym-xp-level-num">' + levelInfo.level + '</div>' +
            '<div class="gym-xp-level-label">LEVEL</div>' +
            '<div class="gym-xp-bar-wrap">' +
                '<div class="gym-xp-bar-fill" style="width:' + (levelInfo.progress * 100) + '%"></div>' +
            '</div>' +
            '<div class="gym-xp-bar-text">' + levelInfo.xpInLevel + ' / 100 XP</div>' +
        '</div>';

        // Level tooltip
        if (showLevelTooltip) {
            html += '<div style="background:#2e2418;border:1px solid var(--gym-border);border-radius:var(--gym-radius-sm);padding:12px 14px;margin:0 0 8px;font-size:13px;color:var(--gym-text-body)">' +
                'Complete workouts (+10 XP), improve your lifts (+2 XP each), train consistently (+5 XP/week), and log nutrition (+1 XP/day) to level up.' +
            '</div>';
        }

        // Stat grid
        html += '<div class="gym-stat-grid">' +
            '<div class="gym-stat-box"><div class="gym-stat-box-value">' + levelInfo.level + '</div><div class="gym-stat-box-label">Level</div></div>' +
            '<div class="gym-stat-box"><div class="gym-stat-box-value">' + weekWorkouts + '</div><div class="gym-stat-box-label">This Week</div></div>' +
            '<div class="gym-stat-box"><div class="gym-stat-box-value">' + streak + '</div><div class="gym-stat-box-label">Streak</div></div>' +
            '<div class="gym-stat-box"><div class="gym-stat-box-value">' + fmtVolume(totalVol) + '</div><div class="gym-stat-box-label">Total Volume</div></div>' +
            '<div class="gym-stat-box"><div class="gym-stat-box-value">' + currentWeight + '</div><div class="gym-stat-box-label">Body Weight</div></div>' +
            '<div class="gym-stat-box"><div class="gym-stat-box-value">' + totalWorkouts + '</div><div class="gym-stat-box-label">Workouts</div></div>' +
        '</div>';

        // Quick Start
        const nextRoutineId = GymService.getNextRoutine(pid);
        const nextRoutine = GymService.getRoutine(nextRoutineId);
        html += '<div class="gym-actions-row">' +
            '<button class="gym-btn-primary" data-action="preview-workout" data-routine="' + nextRoutineId + '">START ' + (nextRoutine ? esc(nextRoutine.name.toUpperCase()) : 'WORKOUT') + '</button>' +
            '<button class="gym-btn-outline" data-action="goto-body">LOG WEIGHT</button>' +
        '</div>';

        // Recent sessions
        html += '<div class="gym-section-title">Recent Sessions</div>';
        if (recent.length === 0) {
            html += '<div class="gym-empty">No workouts logged yet<span class="gym-empty-dash"></span></div>';
        } else {
            html += '<div class="gym-recent-list">';
            recent.forEach(w => {
                const r = GymService.getRoutine(w.routineId);
                const vol = GymService.getWorkoutVolume(w);
                const colorHex = ROUTINE_COLOR_HEX[w.routineId] || '#e8a020';
                html += '<div class="gym-recent-card">' +
                    '<div class="gym-recent-dot" style="background:' + colorHex + '"></div>' +
                    '<div class="gym-recent-info">' +
                        '<div class="gym-recent-routine">' + (r ? esc(r.name) : 'Custom') + '</div>' +
                        '<div class="gym-recent-meta">' + relativeDate(w.date) + '</div>' +
                    '</div>' +
                    '<div class="gym-recent-vol">' + fmtVolume(vol) + ' vol</div>' +
                '</div>';
            });
            html += '</div>';
        }

        return html;
    }

    /* ══════════════════════════════════════════
       TAB 2: TRAIN
    ══════════════════════════════════════════ */
    function renderTrain() {
        const pid = activePlayer;
        const routines = GymService.getRoutines();

        // If in active workout, always show it
        if (trainStep === 'workout' && selectedRoutineId) {
            return renderActiveWorkout();
        }

        if (trainStep === 'preview' && selectedRoutineId) {
            return renderWorkoutPreview();
        }

        if (trainStep === 'program') {
            return renderProgram();
        }

        // Default: Choose Workout
        const settings = GymService.getSettings();
        let html = '<div class="gym-tab-content">';
        html += '<div class="gym-section-title">Choose Workout</div>';
        html += '<div class="gym-workout-grid">';
        routines.forEach(r => {
            const color = ROUTINE_COLORS[r.id] || 'gold';
            const colorHex = ROUTINE_COLOR_HEX[r.id] || '#e8a020';
            const exCount = r.exercises ? r.exercises.length : 0;
            const nextId = GymService.getNextRoutine(pid);
            const isNext = r.id === nextId;
            html += '<div class="gym-workout-pick-card ' + (isNext ? 'suggested' : '') + '" data-action="preview-workout" data-routine="' + esc(r.id) + '">' +
                '<div class="gym-workout-pick-accent" style="background:' + colorHex + '"></div>' +
                '<div class="gym-workout-pick-name">' + esc(r.name) + '</div>' +
                '<div class="gym-workout-pick-desc">' + esc(r.description) + '</div>' +
                '<div class="gym-workout-pick-count">' + exCount + ' exercises</div>' +
                (isNext ? '<span class="gym-workout-pick-next">UP NEXT</span>' : '') +
            '</div>';
        });
        html += '</div>';
        html += '<button class="gym-btn-sm outline" data-action="goto-program" style="width:100%;margin-top:16px">EDIT MY PROGRAM</button>';

        // Inline My Program section
        const allExercises = GymService.getExercises();
        html += '<div class="gym-section-title">My Program</div>';
        routines.forEach(r => {
            const colorHex = ROUTINE_COLOR_HEX[r.id] || '#e8a020';
            html += '<div class="gym-routine-detail">' +
                '<div class="gym-routine-detail-header"><div>' +
                    '<div class="gym-routine-detail-name">' +
                        '<span class="gym-routine-color-dot" style="background:' + colorHex + '"></span>' +
                        esc(r.name) +
                    '</div>' +
                    '<div class="gym-routine-detail-desc">' + esc(r.description) + '</div>' +
                '</div></div>' +
                '<div class="gym-routine-exercises">';
            (r.exercises || []).forEach(re => {
                const exDef = allExercises.find(e => e.id === re.exerciseId);
                const name = exDef ? exDef.name : re.exerciseId;
                html += '<div class="gym-routine-exercise-row">' +
                    '<span class="gym-routine-exercise-name">' + esc(name) + '</span>' +
                    '<span class="gym-routine-exercise-detail">' + re.sets + ' sets × ' + (re.defaultWeight || 0) + ' ' + (settings.weightUnit || 'lbs') + '</span>' +
                '</div>';
            });
            html += '</div></div>';
        });

        html += '</div>';
        return html;
    }

    function renderWorkoutPreview() {
        const routine = GymService.getRoutine(selectedRoutineId);
        if (!routine) return '<div class="gym-tab-content"><div class="gym-empty">Routine not found</div></div>';
        const pid = activePlayer;
        const settings = GymService.getSettings();
        const unit = settings.weightUnit || 'lbs';

        let html = '<div class="gym-tab-content">';
        html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">' +
            '<button class="gym-icon-btn" data-action="back-to-choose" title="Back">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>' +
            '</button>' +
            '<div class="gym-section-title" style="margin:0">' + esc(routine.name) + '</div>' +
        '</div>';

        // Exercise preview list
        html += '<div class="gym-exercise-list">';
        routine.exercises.forEach(re => {
            const exDef = GymService.getExercise(re.exerciseId);
            if (!exDef) return;
            const lastSummary = GymService.getLastSessionSummary(pid, re.exerciseId);
            const prog = GymService.getProgressionSuggestion(pid, re.exerciseId);

            html += '<div class="gym-exercise-card" style="padding:12px 14px">' +
                '<div style="display:flex;align-items:center;justify-content:space-between">' +
                    '<div>' +
                        '<span class="gym-exercise-name" style="font-size:15px">' + esc(exDef.name) + '</span>' +
                        ' <span class="gym-category-pill ' + exDef.category + '">' + exDef.category.toUpperCase() + '</span>' +
                    '</div>' +
                    '<span style="font-family:var(--gym-font-mono);font-size:13px;color:var(--gym-text-muted)">' + re.sets + 's @ ' + re.defaultWeight + unit + '</span>' +
                '</div>';
            if (lastSummary) {
                html += '<div class="gym-exercise-last-session">Last: ' + lastSummary + '</div>';
            }
            if (prog.suggest) {
                html += '<span class="gym-overload-badge" style="margin-top:4px;display:inline-block">INCREASE WEIGHT &rarr; ' + prog.weight + ' ' + unit + '</span>';
            }
            html += '</div>';
        });
        html += '</div>';

        // START WORKOUT button
        html += '<button class="gym-btn-finish" data-action="start-workout" data-routine="' + esc(selectedRoutineId) + '" style="margin-top:20px">START WORKOUT</button>';
        html += '</div>';
        return html;
    }

    function renderActiveWorkout() {
        const routine = GymService.getRoutine(selectedRoutineId);
        if (!routine) return '<div class="gym-tab-content"><div class="gym-empty">Routine not found</div></div>';
        const pid = activePlayer;
        const elapsed = workoutStartTime ? Date.now() - workoutStartTime : 0;

        let html = '<div class="gym-active-workout">';
        html += '<div class="gym-workout-header">' +
            '<div style="display:flex;align-items:center;gap:8px">' +
                '<button class="gym-icon-btn" data-action="back-to-choose" title="Back">' +
                    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>' +
                '</button>' +
                '<div class="gym-workout-title">' + esc(routine.name) + '</div>' +
            '</div>' +
            '<div class="gym-workout-timer" id="gym-timer">' + fmtTimer(elapsed) + '</div>' +
        '</div>';

        // Scrollable exercise list
        html += '<div class="gym-active-workout-list">';
        html += '<div class="gym-exercise-list">';
        routine.exercises.forEach((re, reIdx) => {
            const exDef = GymService.getExercise(re.exerciseId);
            if (!exDef) return;
            const prog = GymService.getProgressionSuggestion(pid, re.exerciseId);
            const lastW = GymService.getLastWeight(pid, re.exerciseId);
            const lastSummary = GymService.getLastSessionSummary(pid, re.exerciseId);
            const suggestedWeight = prog.suggest ? prog.weight : (lastW || re.defaultWeight || 0);
            const lastReps = GymService.getLastReps(pid, re.exerciseId);

            html += '<div class="gym-exercise-card">' +
                '<div class="gym-exercise-header">' +
                    '<div style="flex:1">' +
                        '<div style="display:flex;align-items:center;gap:8px">' +
                            '<div class="gym-exercise-name">' + esc(exDef.name) + '</div>' +
                            '<button class="gym-swap-btn" data-action="swap-exercise" data-ex-idx="' + reIdx + '" title="Swap exercise">⇄</button>' +
                        '</div>' +
                        '<span class="gym-category-pill ' + exDef.category + '">' + exDef.category.toUpperCase() + '</span>' +
                    '</div>' +
                    (prog.suggest ? '<span class="gym-overload-badge">INCREASE WEIGHT &rarr; ' + prog.weight + 'lbs</span>' : '') +
                '</div>';

            if (lastSummary) {
                html += '<div class="gym-exercise-last-session">Last: ' + lastSummary + '</div>';
            }

            // Set rows header
            html += '<div class="gym-set-header-row">' +
                '<span class="gym-set-hdr" style="width:28px">Set</span>' +
                '<span class="gym-set-hdr" style="width:70px">Weight</span>' +
                '<span class="gym-set-hdr" style="width:50px">Reps</span>' +
                '<span class="gym-set-hdr" style="width:56px">RIR</span>' +
                '<span class="gym-set-hdr" style="width:44px"></span>' +
            '</div>';
            html += '<div class="gym-set-rows">';

            const numSets = logState.sets['_count_' + reIdx] || re.sets;
            for (let s = 0; s < numSets; s++) {
                const setKey = reIdx + '-' + s;
                const saved = logState.sets[setKey] || {};
                const w = saved.weight !== undefined ? saved.weight : suggestedWeight;
                const reps = saved.reps !== undefined ? saved.reps : (lastReps || '');
                const rir = saved.rir !== undefined ? saved.rir : 2;
                const done = saved.completed || false;

                html += '<div class="gym-set-row">' +
                    '<span class="gym-set-num">' + (s + 1) + '</span>' +
                    '<input type="number" class="gym-set-input gym-set-weight" data-set="' + setKey + '" value="' + w + '" placeholder="lb" style="width:70px">' +
                    '<input type="number" min="0" max="100" class="gym-set-input gym-set-reps" data-set="' + setKey + '" value="' + (reps || 0) + '" placeholder="0" style="width:50px">' +
                    '<select class="gym-set-rir-select" data-set="' + setKey + '">' +
                        '<option value="0"' + (rir === 0 ? ' selected' : '') + '>0</option>' +
                        '<option value="1"' + (rir === 1 ? ' selected' : '') + '>1</option>' +
                        '<option value="2"' + (rir === 2 ? ' selected' : '') + '>2</option>' +
                        '<option value="3"' + (rir === 3 ? ' selected' : '') + '>3</option>' +
                        '<option value="4"' + (rir >= 4 ? ' selected' : '') + '>4+</option>' +
                    '</select>' +
                    '<button class="gym-set-check ' + (done ? 'done' : '') + '" data-action="complete-set" data-ex-idx="' + reIdx + '" data-set-idx="' + s + '" data-set="' + setKey + '">&#10003;</button>' +
                '</div>';

                // Rest timer display below completed set
                if (done && recordedRests[setKey] !== undefined) {
                    html += '<div class="gym-rest-recorded">Rest was ' + fmtRestTime(recordedRests[setKey]) + '</div>';
                } else if (done && restTimerKey === setKey && restTimerStart) {
                    html += '<div class="gym-rest-active" id="gym-rest-timer">Rest: 0:00</div>';
                }
            }
            html += '</div>';

            // Add set button
            html += '<button class="gym-add-set-btn" data-exercise-idx="' + reIdx + '" data-default-sets="' + re.sets + '">+ Add Set</button>';

            // Exercise notes (collapsible)
            const noteVal = logState.exerciseNotes[reIdx] || '';
            if (showExNotes[reIdx]) {
                html += '<div style="margin-top:8px">' +
                    '<textarea class="gym-log-notes" placeholder="Exercise notes..." data-ex-note="' + reIdx + '">' + esc(noteVal) + '</textarea>' +
                '</div>';
            } else {
                html += '<button class="gym-add-set-btn" data-action="toggle-ex-note" data-ex-idx="' + reIdx + '" style="margin-top:4px;font-size:12px;border:none;text-align:left;padding:4px 0;color:var(--gym-text-muted)">' +
                    (noteVal ? 'Note: ' + esc(noteVal.substring(0, 40)) + '...' : '+ Add note') +
                '</button>';
            }

            html += '</div>'; // end exercise card
        });
        // Render mid-workout additions
        (logState.additions || []).forEach((add, addIdx) => {
            const reIdx = routine.exercises.length + addIdx;
            const exDef = GymService.getExercise(add.exerciseId);
            if (!exDef) return;
            const prog = GymService.getProgressionSuggestion(pid, add.exerciseId);
            const lastW = GymService.getLastWeight(pid, add.exerciseId);
            const lastSummary = GymService.getLastSessionSummary(pid, add.exerciseId);
            const suggestedWeight = prog.suggest ? prog.weight : (lastW || 0);
            const lastReps = GymService.getLastReps(pid, add.exerciseId);

            html += '<div class="gym-exercise-card">' +
                '<div class="gym-exercise-header">' +
                    '<div style="flex:1">' +
                        '<div style="display:flex;align-items:center;gap:8px">' +
                            '<div class="gym-exercise-name">' + esc(exDef.name) + '</div>' +
                            '<span style="font-size:10px;color:#7c6aff;font-weight:600;">ADDED</span>' +
                            '<button class="gym-swap-btn" data-action="swap-exercise" data-ex-idx="' + reIdx + '" title="Swap exercise">⇄</button>' +
                        '</div>' +
                        '<span class="gym-category-pill ' + exDef.category + '">' + exDef.category.toUpperCase() + '</span>' +
                    '</div>' +
                    (prog.suggest ? '<span class="gym-overload-badge">INCREASE WEIGHT &rarr; ' + prog.weight + 'lbs</span>' : '') +
                '</div>';

            if (lastSummary) {
                html += '<div class="gym-exercise-last-session">Last: ' + lastSummary + '</div>';
            }

            html += '<div class="gym-set-header-row">' +
                '<span class="gym-set-hdr" style="width:28px">Set</span>' +
                '<span class="gym-set-hdr" style="width:70px">Weight</span>' +
                '<span class="gym-set-hdr" style="width:50px">Reps</span>' +
                '<span class="gym-set-hdr" style="width:56px">RIR</span>' +
                '<span class="gym-set-hdr" style="width:44px"></span>' +
            '</div>';
            html += '<div class="gym-set-rows">';

            const numSets = logState.sets['_count_' + reIdx] || add.defaultSets || 3;
            for (let s = 0; s < numSets; s++) {
                const setKey = reIdx + '-' + s;
                const saved = logState.sets[setKey] || {};
                const w = saved.weight !== undefined ? saved.weight : suggestedWeight;
                const reps = saved.reps !== undefined ? saved.reps : (lastReps || '');
                const rir = saved.rir !== undefined ? saved.rir : 2;
                const done = saved.completed || false;

                html += '<div class="gym-set-row">' +
                    '<span class="gym-set-num">' + (s + 1) + '</span>' +
                    '<input type="number" class="gym-set-input gym-set-weight" data-set="' + setKey + '" value="' + w + '" placeholder="lb" style="width:70px">' +
                    '<input type="number" min="0" max="100" class="gym-set-input gym-set-reps" data-set="' + setKey + '" value="' + (reps || 0) + '" placeholder="0" style="width:50px">' +
                    '<select class="gym-set-rir-select" data-set="' + setKey + '">' +
                        '<option value="0"' + (rir === 0 ? ' selected' : '') + '>0</option>' +
                        '<option value="1"' + (rir === 1 ? ' selected' : '') + '>1</option>' +
                        '<option value="2"' + (rir === 2 ? ' selected' : '') + '>2</option>' +
                        '<option value="3"' + (rir === 3 ? ' selected' : '') + '>3</option>' +
                        '<option value="4"' + (rir >= 4 ? ' selected' : '') + '>4+</option>' +
                    '</select>' +
                    '<button class="gym-set-check ' + (done ? 'done' : '') + '" data-action="complete-set" data-ex-idx="' + reIdx + '" data-set-idx="' + s + '" data-set="' + setKey + '">&#10003;</button>' +
                '</div>';

                if (done && recordedRests[setKey] !== undefined) {
                    html += '<div class="gym-rest-recorded">Rest was ' + fmtRestTime(recordedRests[setKey]) + '</div>';
                } else if (done && restTimerKey === setKey && restTimerStart) {
                    html += '<div class="gym-rest-active" id="gym-rest-timer">Rest: 0:00</div>';
                }
            }
            html += '</div>';

            html += '<button class="gym-add-set-btn" data-exercise-idx="' + reIdx + '" data-default-sets="' + (add.defaultSets || 3) + '">+ Add Set</button>';

            const noteVal = logState.exerciseNotes[reIdx] || '';
            if (showExNotes[reIdx]) {
                html += '<div style="margin-top:8px">' +
                    '<textarea class="gym-log-notes" placeholder="Exercise notes..." data-ex-note="' + reIdx + '">' + esc(noteVal) + '</textarea>' +
                '</div>';
            } else {
                html += '<button class="gym-add-set-btn" data-action="toggle-ex-note" data-ex-idx="' + reIdx + '" style="margin-top:4px;font-size:12px;border:none;text-align:left;padding:4px 0;color:var(--gym-text-muted)">' +
                    (noteVal ? 'Note: ' + esc(noteVal.substring(0, 40)) + '...' : '+ Add note') +
                '</button>';
            }

            html += '</div>'; // end exercise card
        });

        // Add exercise mid-workout button
        html += '<button class="gym-add-exercise-btn" data-action="add-exercise-mid-workout" style="margin:12px 0;width:100%;padding:12px;background:rgba(124,106,255,0.12);border:1px dashed rgba(124,106,255,0.4);border-radius:10px;color:#7c6aff;font-size:14px;font-weight:600;cursor:pointer;">+ Add Exercise to Workout</button>';

        html += '</div>'; // end exercise-list
        html += '</div>'; // end exercise-scroll

        // FINISH WORKOUT button (simple, no end-of-workout metrics)
        html += '<div class="gym-active-workout-footer">' +
            '<textarea class="gym-log-notes" placeholder="Session notes..." data-field="notes">' + esc(logState.notes) + '</textarea>' +
            '<button class="gym-btn-finish" data-action="save-workout">FINISH WORKOUT</button>' +
        '</div>';
        html += '</div>'; // end gym-active-workout
        return html;
    }

    function renderProgram() {
        const routines = GymService.getRoutines();
        const settings = GymService.getSettings();
        const unit = settings.weightUnit || 'lbs';

        let html = '<div class="gym-tab-content">';
        html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">' +
            '<button class="gym-icon-btn" data-action="back-to-choose" title="Back">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>' +
            '</button>' +
            '<div class="gym-section-title" style="margin:0">My Program</div>' +
        '</div>';

        routines.forEach(r => {
            const colorHex = ROUTINE_COLOR_HEX[r.id] || '#e8a020';
            const isEditing = editingRoutineId === r.id;

            html += '<div class="gym-routine-detail">' +
                '<div class="gym-routine-detail-header">' +
                    '<div>' +
                        '<div class="gym-routine-detail-name">' +
                            '<span class="gym-routine-color-dot" style="background:' + colorHex + '"></span>';
            if (isEditing) {
                html += '<input type="text" class="gym-input" value="' + esc(r.name) + '" data-edit="name" style="width:120px;height:32px;font-size:16px;font-family:var(--gym-font-heading);color:var(--gym-brown)">';
            } else {
                html += '<span data-action="edit-routine" data-routine="' + esc(r.id) + '" style="cursor:pointer">' + esc(r.name) + '</span>';
            }
            html += '</div>' +
                        '<div class="gym-routine-detail-desc">' + esc(r.description) + ' <span class="gym-routine-exercise-count">' + r.exercises.length + ' exercises</span></div>' +
                    '</div>' +
                    '<div style="display:flex;gap:4px;">' +
                        '<button class="gym-icon-btn" data-action="edit-routine" data-routine="' + esc(r.id) + '" title="Edit">' +
                            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
                        '</button>' +
                    '</div>' +
                '</div>' +
                '<div class="gym-routine-exercises">';

            r.exercises.forEach((re, reIdx) => {
                const exDef = GymService.getExercise(re.exerciseId);
                if (isEditing) {
                    html += '<div class="gym-routine-exercise-row" style="gap:6px">' +
                        '<span class="gym-routine-exercise-name" style="flex:1">' + (exDef ? esc(exDef.name) : esc(re.exerciseId)) + '</span>' +
                        '<input type="number" class="gym-input" data-routine-edit="' + esc(r.id) + '" data-ex-idx="' + reIdx + '" data-field="sets" value="' + re.sets + '" style="width:48px;height:32px;font-size:13px;text-align:center" title="Sets">' +
                        '<span style="color:var(--gym-text-muted);font-size:12px">s @</span>' +
                        '<input type="number" class="gym-input" data-routine-edit="' + esc(r.id) + '" data-ex-idx="' + reIdx + '" data-field="defaultWeight" value="' + re.defaultWeight + '" style="width:64px;height:32px;font-size:13px;text-align:center" title="Weight">' +
                        '<span style="color:var(--gym-text-muted);font-size:12px">' + unit + '</span>' +
                    '</div>';
                } else {
                    html += '<div class="gym-routine-exercise-row">' +
                        '<span class="gym-routine-exercise-name">' + (exDef ? esc(exDef.name) : esc(re.exerciseId)) + '</span>' +
                        '<span class="gym-routine-exercise-detail">' + re.sets + 's @ ' + re.defaultWeight + unit + '</span>' +
                    '</div>';
                }
            });
            html += '</div>';

            if (isEditing) {
                html += '<div style="display:flex;gap:8px;margin-top:8px">' +
                    '<button class="gym-btn-sm" data-action="save-routine-edit" data-routine="' + esc(r.id) + '">Save</button>' +
                    '<button class="gym-btn-sm outline" data-action="cancel-routine-edit">Cancel</button>' +
                '</div>';
            }
            html += '</div>';
        });

        // Settings
        html += '<div class="gym-settings-section">' +
            '<div class="gym-section-title">Settings</div>' +
            '<div class="gym-settings-row">' +
                '<span class="gym-settings-label">Rep Range Min</span>' +
                '<input type="number" class="gym-settings-input" data-setting="repRangeMin" value="' + settings.repRangeMin + '">' +
            '</div>' +
            '<div class="gym-settings-row">' +
                '<span class="gym-settings-label">Rep Range Max</span>' +
                '<input type="number" class="gym-settings-input" data-setting="repRangeMax" value="' + settings.repRangeMax + '">' +
            '</div>' +
            '<div class="gym-settings-row">' +
                '<span class="gym-settings-label">Default Sets</span>' +
                '<input type="number" class="gym-settings-input" data-setting="defaultSets" value="' + settings.defaultSets + '">' +
            '</div>' +
            '<div class="gym-settings-row">' +
                '<span class="gym-settings-label">Weight Unit</span>' +
                '<select class="gym-settings-input" data-setting="weightUnit" style="width:80px">' +
                    '<option value="lbs"' + (settings.weightUnit === 'lbs' ? ' selected' : '') + '>lbs</option>' +
                    '<option value="kg"' + (settings.weightUnit === 'kg' ? ' selected' : '') + '>kg</option>' +
                '</select>' +
            '</div>' +
        '</div>';

        // Clear Data
        html += '<div class="gym-settings-section">' +
            '<button class="gym-btn-sm outline" data-action="clear-data" style="border-color:var(--gym-red);color:var(--gym-red)">Clear All Data</button>' +
        '</div>';

        html += '</div>';
        return html;
    }

    /* ══════════════════════════════════════════
       TAB 3: BODY
    ══════════════════════════════════════════ */
    function renderBody() {
        const pid = activePlayer;
        const settings = GymService.getSettings();
        const unit = settings.weightUnit || 'lbs';
        let html = '';

        // Weight section
        const weights = GymService.getWeights(pid);
        const currentWeight = weights.length ? weights[weights.length - 1].value : null;
        html += '<div class="gym-body-section">' +
            '<div class="gym-body-section-title">Weight Tracker</div>';
        if (currentWeight !== null) {
            html += '<div class="gym-current-weight">' +
                '<span class="gym-current-weight-val">' + currentWeight + '</span>' +
                '<span class="gym-current-weight-unit">' + unit + '</span>' +
            '</div>';
        }
        html += '<div class="gym-form-row">' +
                '<input type="number" class="gym-input num" id="gym-weight-val" placeholder="' + unit + '" step="0.1">' +
                '<input type="date" class="gym-input" id="gym-weight-date" value="' + today() + '">' +
                '<button class="gym-btn-sm" data-action="save-weight">Save</button>' +
            '</div>';
        if (weights.length > 0) {
            html += '<table class="gym-weight-table"><thead><tr><th>Date</th><th>Weight</th><th>Delta</th></tr></thead><tbody>';
            const recent = weights.slice(-10).reverse();
            recent.forEach((w, i) => {
                let delta = '';
                const nextIdx = weights.length - 1 - i;
                if (nextIdx > 0) {
                    const diff = (w.value - weights[nextIdx - 1].value).toFixed(1);
                    const cls = parseFloat(diff) > 0 ? 'up' : parseFloat(diff) < 0 ? 'down' : '';
                    delta = '<span class="gym-weight-delta ' + cls + '">' + (parseFloat(diff) > 0 ? '+' : '') + diff + '</span>';
                }
                html += '<tr><td>' + fmtDate(w.date) + '</td><td>' + w.value + ' ' + unit + '</td><td>' + delta + '</td></tr>';
            });
            html += '</tbody></table>';
        }
        html += '</div>';

        // Photo section
        html += '<div class="gym-body-section">' +
            '<div class="gym-body-section-title">Progress Photos</div>' +
            '<div class="gym-form-row">' +
                '<input type="file" accept="image/*" id="gym-photo-input" style="display:none">' +
                '<button class="gym-btn-sm outline" data-action="upload-photo">UPLOAD PHOTO</button>' +
                '<input type="date" class="gym-input" id="gym-photo-date" value="' + today() + '">' +
            '</div>';
        const photos = GymService.getPhotos(pid);
        if (photos.length > 0) {
            html += '<div class="gym-photo-gallery">';
            photos.slice().reverse().forEach(p => {
                html += '<div class="gym-photo-card">' +
                    '<img src="' + p.url + '" alt="Progress photo">' +
                    '<div class="gym-photo-card-date">' + fmtDate(p.date) + '</div>' +
                '</div>';
            });
            html += '</div>';
        }
        html += '</div>';

        return html;
    }

    /* ══════════════════════════════════════════
       TAB 4: NUTRITION
    ══════════════════════════════════════════ */
    function renderNutrition() {
        const pid = activePlayer;
        if (!nutritionDate) nutritionDate = today();
        const dayLog = GymService.getNutritionLog(pid, nutritionDate);
        const meals = dayLog ? dayLog.meals : [];
        const savedMeals = GymService.getSavedMeals(pid);
        const isToday = nutritionDate === today();

        let html = '';

        // Date selector
        html += '<div class="gym-nutrition-date-nav">' +
            '<button class="gym-icon-btn" data-action="nutrition-prev-day">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 19l-7-7 7-7"/></svg>' +
            '</button>' +
            '<div class="gym-nutrition-date-label">' + (isToday ? 'Today' : fmtDate(nutritionDate)) + '</div>' +
            '<button class="gym-icon-btn" data-action="nutrition-next-day">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5l7 7-7 7"/></svg>' +
            '</button>' +
        '</div>';

        // Daily totals
        let totalCal = 0, totalP = 0, totalC = 0, totalF = 0;
        meals.forEach(m => {
            totalCal += m.calories || 0;
            totalP += m.protein || 0;
            totalC += m.carbs || 0;
            totalF += m.fat || 0;
        });
        html += '<div class="gym-diet-summary">' +
            '<div class="gym-diet-bar-card"><div class="gym-diet-bar-val">' + totalCal + '</div><div class="gym-diet-bar-label">Calories</div><div class="gym-diet-bar-fill"><div class="gym-diet-bar-fill-inner" style="width:' + Math.min(100, (totalCal / 2500) * 100) + '%;background:#e8a020"></div></div></div>' +
            '<div class="gym-diet-bar-card"><div class="gym-diet-bar-val">' + totalP + 'g</div><div class="gym-diet-bar-label">Protein</div><div class="gym-diet-bar-fill"><div class="gym-diet-bar-fill-inner" style="width:' + Math.min(100, (totalP / 180) * 100) + '%;background:#0984e3"></div></div></div>' +
            '<div class="gym-diet-bar-card"><div class="gym-diet-bar-val">' + totalC + 'g</div><div class="gym-diet-bar-label">Carbs</div><div class="gym-diet-bar-fill"><div class="gym-diet-bar-fill-inner" style="width:' + Math.min(100, (totalC / 300) * 100) + '%;background:#2ecc71"></div></div></div>' +
            '<div class="gym-diet-bar-card"><div class="gym-diet-bar-val">' + totalF + 'g</div><div class="gym-diet-bar-label">Fat</div><div class="gym-diet-bar-fill"><div class="gym-diet-bar-fill-inner" style="width:' + Math.min(100, (totalF / 80) * 100) + '%;background:#e74c3c"></div></div></div>' +
        '</div>';

        // Meals list
        if (meals.length > 0) {
            html += '<div class="gym-diet-items">';
            meals.forEach(m => {
                html += '<div class="gym-diet-item">' +
                    '<div style="flex:1;min-width:0">' +
                        '<span class="gym-diet-item-name">' + esc(m.name) + '</span>' +
                        (m.time ? '<span style="font-size:11px;color:var(--gym-text-muted);margin-left:6px">' + m.time + '</span>' : '') +
                    '</div>' +
                    '<span class="gym-diet-item-macros">' + (m.calories || 0) + 'cal ' + (m.protein || 0) + 'p ' + (m.carbs || 0) + 'c ' + (m.fat || 0) + 'f</span>' +
                '</div>';
            });
            html += '</div>';
        } else {
            html += '<div class="gym-empty" style="padding:16px">No meals logged' + (isToday ? ' today' : '') + '<span class="gym-empty-dash"></span></div>';
        }

        // Add Meal button / form
        if (showMealForm) {
            const pf = mealFormPrefill || {};
            html += '<div class="gym-nutrition-form">' +
                '<div class="gym-section-title" style="margin:8px 0">Add Meal</div>' +
                '<input type="text" class="gym-input wide" id="gym-meal-name" placeholder="Meal name" list="gym-meal-suggestions" value="' + esc(pf.name || '') + '" style="width:100%;margin-bottom:8px">' +
                '<datalist id="gym-meal-suggestions">';
            savedMeals.forEach(sm => {
                html += '<option value="' + esc(sm.name) + '">';
            });
            html += '</datalist>' +
                '<div class="gym-form-row" style="margin-bottom:8px">' +
                    '<input type="number" class="gym-input num" id="gym-meal-cal" placeholder="kcal"' + (pf.calories ? ' value="' + pf.calories + '"' : '') + '>' +
                    '<input type="number" class="gym-input num" id="gym-meal-protein" placeholder="prot"' + (pf.protein ? ' value="' + pf.protein + '"' : '') + '>' +
                    '<input type="number" class="gym-input num" id="gym-meal-carbs" placeholder="carbs"' + (pf.carbs ? ' value="' + pf.carbs + '"' : '') + '>' +
                    '<input type="number" class="gym-input num" id="gym-meal-fat" placeholder="fat"' + (pf.fat ? ' value="' + pf.fat + '"' : '') + '>' +
                '</div>' +
                '<input type="text" class="gym-input wide" id="gym-meal-notes" placeholder="Notes (optional)" style="width:100%;margin-bottom:8px">' +
                '<div style="display:flex;gap:8px">' +
                    '<button class="gym-btn-sm" data-action="save-meal">SAVE MEAL</button>' +
                    '<button class="gym-btn-sm outline" data-action="cancel-meal">CANCEL</button>' +
                '</div>' +
            '</div>';
        } else {
            html += '<button class="gym-btn-full" data-action="add-meal" style="margin-top:16px">+ Add Meal</button>';
        }

        // Saved Meals library
        if (savedMeals.length > 0) {
            html += '<div class="gym-section-title">Saved Meals</div>' +
                '<div class="gym-saved-meals-grid">';
            savedMeals.forEach(sm => {
                html += '<div class="gym-saved-meal-chip" data-action="quick-log-meal" data-meal-id="' + esc(sm.id) + '">' +
                    '<span class="gym-saved-meal-delete" data-action="delete-saved-meal" data-meal-id="' + esc(sm.id) + '">&times;</span>' +
                    '<div class="gym-saved-meal-name">' + esc(sm.name) + '</div>' +
                    '<div class="gym-saved-meal-macros">' + sm.calories + 'cal &middot; ' + sm.protein + 'p</div>' +
                '</div>';
            });
            html += '</div>';
        }

        return html;
    }

    /* ══════════════════════════════════════════
       MAIN RENDER
    ══════════════════════════════════════════ */
    function render() {
        const hex = playerColorHex(activePlayer);
        const player = GymService.getPlayer(activePlayer);
        const initial = player ? player.name.charAt(0).toUpperCase() : '?';

        return '<div class="gym-panel">' +
            '<div class="gym-header">' +
                '<div class="gym-header-title">Gym</div>' +
                '<div class="gym-header-player" data-action="toggle-player-switcher" title="Switch player">' +
                    '<div class="gym-header-player-circle" style="background:' + hex + '">' + initial + '</div>' +
                '</div>' +
            '</div>' +
            '<div class="gym-tabs">' + renderTabs() + '</div>' +
            '<div id="gym-tab-content"></div>' +
        '</div>';
    }

    function renderActiveTab() {
        const el = container && container.querySelector('#gym-tab-content');
        if (!el) return;
        disposeCharacter();
        switch (activeTab) {
            case 'dashboard': el.innerHTML = '<div class="gym-tab-content">' + renderDashboard() + '</div>'; initDashboard(); break;
            case 'train':     el.innerHTML = renderTrain(); startTimerTick(); startRestTimerTick(); break;
            case 'body':      el.innerHTML = '<div class="gym-tab-content">' + renderBody() + '</div>'; break;
            case 'nutrition':  el.innerHTML = '<div class="gym-tab-content">' + renderNutrition() + '</div>'; break;
        }
    }

    function initDashboard() {
        const wrap = container && container.querySelector('#gym-char-canvas');
        if (wrap) initCharacterCanvas(wrap);
    }

    function startTimerTick() {
        clearInterval(timerInterval);
        if (!workoutStartTime || !selectedRoutineId || trainStep !== 'workout') return;
        timerInterval = setInterval(() => {
            const el = container && container.querySelector('#gym-timer');
            if (el) el.textContent = fmtTimer(Date.now() - workoutStartTime);
        }, 1000);
    }

    function startRestTimerTick() {
        clearInterval(restTimerInterval);
        if (!restTimerStart || !restTimerKey) return;
        restTimerInterval = setInterval(() => {
            const el = container && container.querySelector('#gym-rest-timer');
            if (el && restTimerStart) {
                const elapsed = Math.round((Date.now() - restTimerStart) / 1000);
                el.textContent = 'Rest: ' + fmtRestTime(elapsed);
            }
        }, 1000);
    }

    function stopRestTimer() {
        if (restTimerStart && restTimerKey) {
            const elapsed = Math.round((Date.now() - restTimerStart) / 1000);
            recordedRests[restTimerKey] = elapsed;
        }
        restTimerStart = null;
        restTimerKey = null;
        clearInterval(restTimerInterval);
    }

    /* ── Event Binding (delegation-based) ── */
    function bindEvents() {
        if (!container) return;
        container.querySelectorAll('.gym-tab').forEach(el => {
            el.addEventListener('click', () => {
                activeTab = el.dataset.tab;
                container.querySelectorAll('.gym-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
                renderActiveTab();
            });
        });
        // Header player avatar click
        const headerPlayer = container.querySelector('.gym-header-player');
        if (headerPlayer) {
            headerPlayer.addEventListener('click', () => {
                showPlayerSwitcher = !showPlayerSwitcher;
                renderActiveTab();
            });
        }
        setupDelegation();
        renderActiveTab();
    }

    function setupDelegation() {
        const content = container.querySelector('#gym-tab-content');
        if (!content) return;

        /* ── Click delegation ── */
        content.addEventListener('click', function(e) {
            /* Actions via data-action */
            var actionEl = e.target.closest('[data-action]');
            if (actionEl) {
                var action = actionEl.dataset.action;

                if (action === 'toggle-level-info') { showLevelTooltip = !showLevelTooltip; renderActiveTab(); return; }
                if (action === 'toggle-player-switcher') { showPlayerSwitcher = !showPlayerSwitcher; renderActiveTab(); return; }

                if (action === 'preview-workout') {
                    selectedRoutineId = actionEl.dataset.routine;
                    trainStep = 'preview';
                    activeTab = 'train';
                    container.querySelectorAll('.gym-tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tab === 'train'); });
                    renderActiveTab(); return;
                }

                if (action === 'start-workout') {
                    selectedRoutineId = actionEl.dataset.routine || selectedRoutineId;
                    trainStep = 'workout';
                    logState = { notes: '', sets: {}, exerciseNotes: {}, additions: [] };
                    showExNotes = {};
                    recordedRests = {};
                    restTimerStart = null;
                    restTimerKey = null;
                    workoutStartTime = Date.now();
                    renderActiveTab(); return;
                }

                if (action === 'goto-body') {
                    activeTab = 'body';
                    container.querySelectorAll('.gym-tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tab === 'body'); });
                    renderActiveTab(); return;
                }

                if (action === 'goto-program') {
                    trainStep = 'program';
                    renderActiveTab(); return;
                }

                if (action === 'back-to-choose') {
                    if (trainStep === 'workout' && workoutStartTime) {
                        if (!confirm('Abandon current workout?')) return;
                    }
                    trainStep = 'choose';
                    selectedRoutineId = null;
                    workoutStartTime = null;
                    clearInterval(timerInterval);
                    stopRestTimer();
                    editingRoutineId = null;
                    renderActiveTab(); return;
                }

                if (action === 'complete-set') {
                    var csKey = actionEl.dataset.exIdx + '-' + actionEl.dataset.setIdx;
                    captureSetInputs(csKey);
                    if (!logState.sets[csKey]) logState.sets[csKey] = {};
                    var wasDone = logState.sets[csKey].completed;
                    logState.sets[csKey].completed = !wasDone;
                    if (!wasDone) {
                        if (restTimerStart && restTimerKey) {
                            recordedRests[restTimerKey] = Math.round((Date.now() - restTimerStart) / 1000);
                        }
                        restTimerStart = Date.now();
                        restTimerKey = csKey;
                        renderActiveTab();
                    } else {
                        actionEl.classList.toggle('done', false);
                    }
                    return;
                }

                if (action === 'save-workout') { saveWorkout(); return; }

                if (action === 'swap-exercise') {
                    var exIdx = parseInt(actionEl.dataset.exIdx);
                    showExerciseSwapModal(exIdx, 'swap');
                    return;
                }

                if (action === 'add-exercise-mid-workout') {
                    showExerciseSwapModal(null, 'add');
                    return;
                }

                if (action === 'toggle-ex-note') {
                    var exIdx = parseInt(actionEl.dataset.exIdx);
                    showExNotes[exIdx] = !showExNotes[exIdx];
                    renderActiveTab(); return;
                }

                if (action === 'edit-routine') {
                    editingRoutineId = editingRoutineId === actionEl.dataset.routine ? null : actionEl.dataset.routine;
                    renderActiveTab(); return;
                }

                if (action === 'cancel-routine-edit') {
                    editingRoutineId = null;
                    renderActiveTab(); return;
                }

                if (action === 'save-routine-edit') {
                    var rid = actionEl.dataset.routine;
                    var routine = GymService.getRoutine(rid);
                    if (!routine) return;
                    var nameInput = content.querySelector('[data-edit="name"]');
                    if (nameInput) routine.name = nameInput.value;
                    // Save exercise edits
                    content.querySelectorAll('[data-routine-edit="' + rid + '"]').forEach(function(inp) {
                        var exIdx = parseInt(inp.dataset.exIdx);
                        var field = inp.dataset.field;
                        if (routine.exercises[exIdx]) {
                            routine.exercises[exIdx][field] = parseFloat(inp.value) || 0;
                        }
                    });
                    GymService.updateRoutine(rid, routine);
                    editingRoutineId = null;
                    renderActiveTab();
                    showToast('Routine saved'); return;
                }

                if (action === 'clear-data') {
                    if (confirm('Clear ALL gym data? This cannot be undone.')) {
                        GymService.clearData(); showToast('Data cleared');
                        container.innerHTML = render(); bindEvents();
                    }
                    return;
                }

                if (action === 'save-weight') {
                    var wVal = document.getElementById('gym-weight-val');
                    var wDate = document.getElementById('gym-weight-date');
                    if (!wVal || !wVal.value) return;
                    GymService.logWeight(activePlayer, wDate ? wDate.value : today(), wVal.value);
                    showToast('Weight logged'); renderActiveTab(); return;
                }

                if (action === 'upload-photo') {
                    var inp = document.getElementById('gym-photo-input');
                    if (inp) inp.click(); return;
                }

                // Nutrition actions
                if (action === 'nutrition-prev-day') {
                    var d = new Date(nutritionDate);
                    d.setDate(d.getDate() - 1);
                    nutritionDate = d.toISOString().slice(0, 10);
                    renderActiveTab(); return;
                }
                if (action === 'nutrition-next-day') {
                    var d2 = new Date(nutritionDate);
                    d2.setDate(d2.getDate() + 1);
                    nutritionDate = d2.toISOString().slice(0, 10);
                    renderActiveTab(); return;
                }
                if (action === 'add-meal') { showMealForm = true; mealFormPrefill = null; renderActiveTab(); return; }
                if (action === 'cancel-meal') { showMealForm = false; mealFormPrefill = null; renderActiveTab(); return; }
                if (action === 'save-meal') { saveMeal(); return; }
                if (action === 'delete-saved-meal') {
                    GymService.deleteSavedMeal(activePlayer, actionEl.dataset.mealId);
                    showToast('Saved meal removed');
                    renderActiveTab();
                    return;
                }
                if (action === 'quick-log-meal') {
                    var mealId = actionEl.dataset.mealId;
                    var saved = GymService.getSavedMeals(activePlayer);
                    var sm = saved.find(function(m) { return m.id === mealId; });
                    if (sm) {
                        mealFormPrefill = { name: sm.name, calories: sm.calories, protein: sm.protein, carbs: sm.carbs, fat: sm.fat };
                        showMealForm = true;
                        renderActiveTab();
                    }
                    return;
                }
            }

            /* Player switcher cards */
            var switchCard = e.target.closest('[data-switch-player]');
            if (switchCard) {
                activePlayer = switchCard.dataset.switchPlayer;
                showPlayerSwitcher = false;
                container.innerHTML = render();
                bindEvents();
                return;
            }

            /* Set check button */
            var setCheck = e.target.closest('.gym-set-check');
            if (setCheck) {
                var key = setCheck.dataset.set;
                // Capture current input values from DOM
                captureSetInputs(key);
                if (!logState.sets[key]) logState.sets[key] = {};
                var wasDone = logState.sets[key].completed;
                logState.sets[key].completed = !wasDone;

                if (!wasDone) {
                    // Just marked done - start rest timer
                    if (restTimerStart && restTimerKey) {
                        // Record previous rest
                        recordedRests[restTimerKey] = Math.round((Date.now() - restTimerStart) / 1000);
                    }
                    restTimerStart = Date.now();
                    restTimerKey = key;
                    renderActiveTab();
                } else {
                    // Unchecked - just toggle
                    setCheck.classList.toggle('done', false);
                }
                return;
            }

            /* Add set button */
            var addSetBtn = e.target.closest('.gym-add-set-btn[data-exercise-idx]');
            if (addSetBtn) {
                var exIdx = parseInt(addSetBtn.dataset.exerciseIdx);
                var defSets = parseInt(addSetBtn.dataset.defaultSets);
                var countKey = '_count_' + exIdx;
                captureAllSetInputs();
                logState.sets[countKey] = (logState.sets[countKey] || defSets) + 1;
                renderActiveTab(); return;
            }
        });

        /* ── Input delegation ── */
        content.addEventListener('input', function(e) {
            if (e.target.matches('.gym-set-weight')) {
                var key = e.target.dataset.set;
                if (!logState.sets[key]) logState.sets[key] = {};
                logState.sets[key].weight = parseFloat(e.target.value) || 0;
            }
            if (e.target.matches('.gym-set-reps')) {
                var key = e.target.dataset.set;
                if (!logState.sets[key]) logState.sets[key] = {};
                logState.sets[key].reps = parseInt(e.target.value) || 0;
            }
            if (e.target.matches('[data-field="notes"]')) {
                logState.notes = e.target.value;
            }
            if (e.target.matches('[data-ex-note]')) {
                var idx = parseInt(e.target.dataset.exNote);
                logState.exerciseNotes[idx] = e.target.value;
            }
            // Auto-fill meal form from saved meal selection
            if (e.target.matches('#gym-meal-name')) {
                var mName = e.target.value;
                var saved = GymService.getSavedMeals(activePlayer);
                var match = saved.find(function(m) { return m.name.toLowerCase() === mName.toLowerCase(); });
                if (match) {
                    var calEl = document.getElementById('gym-meal-cal');
                    var protEl = document.getElementById('gym-meal-protein');
                    var carbsEl = document.getElementById('gym-meal-carbs');
                    var fatEl = document.getElementById('gym-meal-fat');
                    if (calEl && !calEl.value) calEl.value = match.calories;
                    if (protEl && !protEl.value) protEl.value = match.protein;
                    if (carbsEl && !carbsEl.value) carbsEl.value = match.carbs;
                    if (fatEl && !fatEl.value) fatEl.value = match.fat;
                }
            }
        });

        /* ── Change delegation ── */
        content.addEventListener('change', function(e) {
            if (e.target.matches('.gym-set-rir-select')) {
                var key = e.target.dataset.set;
                if (!logState.sets[key]) logState.sets[key] = {};
                logState.sets[key].rir = parseInt(e.target.value);
            }
            if (e.target.matches('.gym-settings-input[data-setting]')) {
                var obj = {};
                if (e.target.tagName === 'SELECT') obj[e.target.dataset.setting] = e.target.value;
                else obj[e.target.dataset.setting] = parseInt(e.target.value) || 0;
                GymService.updateSettings(obj);
            }
            if (e.target.matches('#gym-photo-input')) {
                handlePhotoUpload();
            }
        });

        /* ── Focusin delegation (for rest timer) ── */
        content.addEventListener('focusin', function(e) {
            if (restTimerStart && restTimerKey && (e.target.matches('.gym-set-weight') || e.target.matches('.gym-set-reps'))) {
                var focusedKey = e.target.dataset.set;
                if (focusedKey !== restTimerKey) {
                    stopRestTimer();
                    // Update the rest timer display without full re-render
                    var restEl = content.querySelector('#gym-rest-timer');
                    if (restEl && recordedRests[restTimerKey] !== undefined) {
                        // This key was already cleared by stopRestTimer setting restTimerKey=null
                        // Find the previous key from recordedRests
                    }
                    renderActiveTab();
                }
            }
        });
    }

    /* ── Capture set input values from DOM before re-render ── */
    function captureSetInputs(setKey) {
        if (!container) return;
        var weightEl = container.querySelector('.gym-set-weight[data-set="' + setKey + '"]');
        var repsEl = container.querySelector('.gym-set-reps[data-set="' + setKey + '"]');
        var rirEl = container.querySelector('.gym-set-rir-select[data-set="' + setKey + '"]');
        if (!logState.sets[setKey]) logState.sets[setKey] = {};
        if (weightEl) logState.sets[setKey].weight = parseFloat(weightEl.value) || 0;
        if (repsEl) logState.sets[setKey].reps = parseInt(repsEl.value) || 0;
        if (rirEl) logState.sets[setKey].rir = parseInt(rirEl.value);
    }

    function captureAllSetInputs() {
        if (!container) return;
        container.querySelectorAll('.gym-set-weight').forEach(function(el) {
            var key = el.dataset.set;
            if (!logState.sets[key]) logState.sets[key] = {};
            logState.sets[key].weight = parseFloat(el.value) || 0;
        });
        container.querySelectorAll('.gym-set-reps').forEach(function(el) {
            var key = el.dataset.set;
            if (!logState.sets[key]) logState.sets[key] = {};
            logState.sets[key].reps = parseInt(el.value) || 0;
        });
        container.querySelectorAll('.gym-set-rir-select').forEach(function(el) {
            var key = el.dataset.set;
            if (!logState.sets[key]) logState.sets[key] = {};
            logState.sets[key].rir = parseInt(el.value);
        });
        // Notes
        var notesEl = container.querySelector('[data-field="notes"]');
        if (notesEl) logState.notes = notesEl.value;
        container.querySelectorAll('[data-ex-note]').forEach(function(el) {
            logState.exerciseNotes[parseInt(el.dataset.exNote)] = el.value;
        });
    }

    /* ── Exercise Swap Modal ── */
    function showExerciseSwapModal(exerciseIdx, mode) {
        mode = mode || 'swap';
        const routine = GymService.getRoutine(selectedRoutineId);
        if (!routine) return;
        const currentEx = mode === 'swap' ? routine.exercises[exerciseIdx] : null;
        const currentExDef = currentEx ? GymService.getExercise(currentEx.exerciseId) : null;
        const allExercises = GymService.getExercises();

        // Group by category
        const categories = {};
        allExercises.forEach(ex => {
            if (!categories[ex.category]) categories[ex.category] = [];
            categories[ex.category].push(ex);
        });

        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:flex-end;justify-content:center;';

        const modal = document.createElement('div');
        modal.style.cssText = 'background:#1a1a2e;border-radius:16px 16px 0 0;width:100%;max-width:480px;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;';

        // Header
        var html = '<div style="padding:16px 16px 8px;border-bottom:1px solid rgba(255,255,255,0.1);">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">';
        html += '<div style="font-weight:700;color:#fff;font-size:15px;">' + (mode === 'add' ? 'Add Exercise to Workout' : 'Swap Exercise') + '</div>';
        html += '<button id="swap-modal-close" style="background:none;border:none;color:#aaa;font-size:20px;cursor:pointer;padding:4px">✕</button>';
        html += '</div>';
        if (mode === 'swap') {
            html += '<div style="font-size:12px;color:#888;">Replacing: <span style="color:#e8a020;">' + (currentExDef ? esc(currentExDef.name) : 'Unknown') + '</span></div>';
        }
        // Search input
        html += '<input type="text" id="swap-search" placeholder="Search exercises..." style="width:100%;margin-top:10px;padding:8px 12px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#fff;font-size:13px;box-sizing:border-box;">';
        html += '</div>';

        // Exercise list
        html += '<div id="swap-exercise-list" style="overflow-y:auto;flex:1;padding:8px 0;">';
        Object.entries(categories).sort().forEach(function(entry) {
            var cat = entry[0], exes = entry[1];
            html += '<div class="swap-cat-group">';
            html += '<div style="padding:8px 16px 4px;font-size:11px;font-weight:700;text-transform:uppercase;color:#888;letter-spacing:0.5px;">' + esc(cat) + '</div>';
            exes.forEach(function(ex) {
                var isCurrent = currentEx && ex.id === currentEx.exerciseId;
                html += '<button class="swap-exercise-btn" data-ex-id="' + ex.id + '" style="width:100%;text-align:left;padding:12px 16px;background:' + (isCurrent ? 'rgba(232,160,32,0.15)' : 'none') + ';border:none;cursor:pointer;color:' + (isCurrent ? '#e8a020' : '#fff') + ';font-size:14px;display:flex;align-items:center;gap:10px;">';
                html += '<span style="flex:1">' + esc(ex.name) + '</span>';
                if (isCurrent) html += '<span style="font-size:11px;color:#e8a020;">current</span>';
                html += '</button>';
            });
            html += '</div>';
        });
        html += '</div>';

        // Add new exercise section
        html += '<div id="swap-add-new-wrap" style="border-top:1px solid rgba(255,255,255,0.1);padding:12px 16px;">';
        html += '<button id="swap-show-add" style="background:none;border:none;color:#7c6aff;font-size:13px;cursor:pointer;padding:0;font-weight:600;">+ Add new exercise</button>';
        html += '<div id="swap-add-form" style="display:none;margin-top:10px;">';
        html += '<input type="text" id="swap-new-name" placeholder="Exercise name" style="width:100%;padding:8px 12px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#fff;font-size:13px;box-sizing:border-box;margin-bottom:8px;">';
        html += '<select id="swap-new-cat" style="width:100%;padding:8px 12px;background:#1a1a2e;border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#fff;font-size:13px;box-sizing:border-box;margin-bottom:8px;">';
        ['chest','back','shoulders','arms','legs','core','cardio','other'].forEach(function(c) {
            html += '<option value="' + c + '">' + c.charAt(0).toUpperCase() + c.slice(1) + '</option>';
        });
        html += '</select>';
        html += '<button id="swap-save-new" style="width:100%;padding:10px;background:#7c6aff;border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;">Add & Use This Exercise</button>';
        html += '</div>';
        html += '</div>';

        modal.innerHTML = html;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Close handlers
        overlay.querySelector('#swap-modal-close').addEventListener('click', function() { overlay.remove(); });
        overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

        // Search filter
        var searchInput = overlay.querySelector('#swap-search');
        searchInput.addEventListener('input', function() {
            var q = searchInput.value.toLowerCase();
            overlay.querySelectorAll('.swap-exercise-btn').forEach(function(btn) {
                var name = btn.textContent.toLowerCase();
                btn.style.display = name.includes(q) ? '' : 'none';
            });
            overlay.querySelectorAll('.swap-cat-group').forEach(function(g) {
                var visible = [].slice.call(g.querySelectorAll('.swap-exercise-btn')).some(function(b) { return b.style.display !== 'none'; });
                g.style.display = visible ? '' : 'none';
            });
        });
        searchInput.focus();

        // Select exercise
        overlay.querySelectorAll('.swap-exercise-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var newExId = btn.dataset.exId;
                if (mode === 'add') {
                    logState.additions.push({ exerciseId: newExId, defaultSets: 3 });
                    overlay.remove();
                    renderActiveTab();
                    return;
                }
                if (newExId === currentEx.exerciseId) { overlay.remove(); return; }
                // Apply swap to logState (in-session swap, not permanent)
                if (!logState.swaps) logState.swaps = {};
                logState.swaps[exerciseIdx] = newExId;
                // Also swap in the runtime routine (clone to avoid mutating original)
                routine.exercises[exerciseIdx] = Object.assign({}, currentEx, { exerciseId: newExId });
                overlay.remove();
                renderActiveTab();
            });
        });

        // Add new exercise
        overlay.querySelector('#swap-show-add').addEventListener('click', function() {
            overlay.querySelector('#swap-add-form').style.display = '';
            overlay.querySelector('#swap-show-add').style.display = 'none';
        });
        overlay.querySelector('#swap-save-new').addEventListener('click', function() {
            var name = overlay.querySelector('#swap-new-name').value.trim();
            if (!name) return;
            var cat = overlay.querySelector('#swap-new-cat').value;
            var newId = 'custom_' + Date.now();
            GymService.addExercise({ id: newId, name: name, category: cat, equipment: 'any' });
            if (mode === 'add') {
                logState.additions.push({ exerciseId: newId, defaultSets: 3 });
                overlay.remove();
                renderActiveTab();
                return;
            }
            // Apply swap
            if (!logState.swaps) logState.swaps = {};
            logState.swaps[exerciseIdx] = newId;
            routine.exercises[exerciseIdx] = Object.assign({}, currentEx, { exerciseId: newId });
            overlay.remove();
            renderActiveTab();
        });
    }

    /* ── Actions ── */
    function saveWorkout() {
        if (!selectedRoutineId) return;
        const routine = GymService.getRoutine(selectedRoutineId);
        if (!routine) return;

        // Capture any remaining inputs
        captureAllSetInputs();

        const exercises = routine.exercises.map((re, reIdx) => {
            const sets = [];
            const numSets = logState.sets['_count_' + reIdx] || re.sets;
            for (let s = 0; s < numSets; s++) {
                const key = reIdx + '-' + s;
                const saved = logState.sets[key] || {};
                sets.push({
                    setType: saved.setType || 'working',
                    weight: saved.weight !== undefined ? saved.weight : (re.defaultWeight || 0),
                    reps: saved.reps !== undefined ? saved.reps : 0,
                    rir: saved.rir !== undefined ? saved.rir : 2,
                    completed: saved.completed || false
                });
            }
            return {
                exerciseId: re.exerciseId,
                notes: logState.exerciseNotes[reIdx] || '',
                sets
            };
        });

        // Include mid-workout additions
        (logState.additions || []).forEach((add, addIdx) => {
            const reIdx = routine.exercises.length + addIdx;
            const sets = [];
            const numSets = logState.sets['_count_' + reIdx] || add.defaultSets || 3;
            for (let s = 0; s < numSets; s++) {
                const key = reIdx + '-' + s;
                const saved = logState.sets[key] || {};
                sets.push({
                    setType: 'working',
                    weight: saved.weight || 0,
                    reps: saved.reps || 0,
                    rir: saved.rir !== undefined ? saved.rir : 2,
                    completed: saved.completed || false
                });
            }
            exercises.push({
                exerciseId: add.exerciseId,
                notes: logState.exerciseNotes[reIdx] || '',
                sets,
                addedMidWorkout: true
            });
        });

        const workout = {
            date: today(),
            routineId: selectedRoutineId,
            startTime: workoutStartTime ? new Date(workoutStartTime).toISOString() : null,
            endTime: new Date().toISOString(),
            notes: logState.notes,
            exercises
        };

        GymService.logWorkout(activePlayer, workout);
        logState = { notes: '', sets: {}, exerciseNotes: {}, additions: [] };
        showExNotes = {};
        recordedRests = {};
        workoutStartTime = null;
        selectedRoutineId = null;
        trainStep = 'choose';
        clearInterval(timerInterval);
        stopRestTimer();
        showToast('Workout saved!');
        activeTab = 'dashboard';
        container.querySelectorAll('.gym-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'dashboard'));
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
            const img = new Image();
            img.onload = function () {
                const maxW = 800;
                let w = img.width, h = img.height;
                if (w > maxW) { h = (h * maxW) / w; w = maxW; }
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                GymService.addPhoto(activePlayer, { date, url: canvas.toDataURL('image/jpeg', 0.8) });
                showToast('Photo added');
                renderActiveTab();
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    function saveMeal() {
        const nameEl = document.getElementById('gym-meal-name');
        const calEl = document.getElementById('gym-meal-cal');
        const protEl = document.getElementById('gym-meal-protein');
        const carbsEl = document.getElementById('gym-meal-carbs');
        const fatEl = document.getElementById('gym-meal-fat');
        const notesEl = document.getElementById('gym-meal-notes');
        if (!nameEl || !nameEl.value.trim()) { showToast('Enter a meal name'); return; }
        GymService.logNutritionMeal(activePlayer, nutritionDate || today(), {
            name: nameEl.value.trim(),
            calories: parseInt(calEl && calEl.value) || 0,
            protein: parseInt(protEl && protEl.value) || 0,
            carbs: parseInt(carbsEl && carbsEl.value) || 0,
            fat: parseInt(fatEl && fatEl.value) || 0,
            notes: notesEl ? notesEl.value : ''
        });
        showMealForm = false;
        mealFormPrefill = null;
        showToast('Meal logged');
        renderActiveTab();
    }

    /* ── Public API ── */
    return {
        open(bodyEl) {
            container = bodyEl;
            GymService.load();
            nutritionDate = today();
            container.innerHTML = render();
            bindEvents();
        },
        close() {
            disposeCharacter();
            clearInterval(timerInterval);
            clearInterval(restTimerInterval);
            container = null;
            activeTab = 'dashboard';
            selectedRoutineId = null;
            trainStep = 'choose';
            logState = { notes: '', sets: {}, exerciseNotes: {}, additions: [] };
            editingRoutineId = null;
            workoutStartTime = null;
            showLevelTooltip = false;
            showPlayerSwitcher = false;
            showMealForm = false;
            mealFormPrefill = null;
            showExNotes = {};
            restTimerStart = null;
            restTimerKey = null;
            recordedRests = {};
        }
    };
})();

BuildingRegistry.register('Gym', {
    open: (bodyEl, opts) => GymUI.open(bodyEl, opts),
    close: () => GymUI.close()
});
