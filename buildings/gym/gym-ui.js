/* ── Gym UI ── BusinessWorld Warm Aesthetic ── */
const GymUI = (() => {
    let container = null;
    let activeTab = 'dashboard';
    let activePlayer = 'tyler';
    let selectedRoutineId = null;
    let logState = { feeling: 3, notes: '', sets: {} };
    let progressMetric = 'weight';
    let editingRoutineId = null;
    let workoutStartTime = null;
    let timerInterval = null;
    let gymCharacterRenderer = null;
    let characterAnimFrame = null;
    let showChallengeForm = false;

    const ROUTINE_COLORS = { upper1: 'gold', lower1: 'blue', upper2: 'green', lower2: 'red' };
    const ROUTINE_COLOR_HEX = { upper1: '#e8a020', lower1: '#0984e3', upper2: '#2ecc71', lower2: '#e74c3c' };
    const PLAYER_GRADIENTS = [
        ['#e8a020', '#e67e22'], ['#0984e3', '#2196f3'], ['#2ecc71', '#27ae60'],
        ['#e74c3c', '#c0392b'], ['#9b59b6', '#8e44ad'], ['#1abc9c', '#16a085']
    ];

    /* ── SVG Tab Icons ── */
    const TAB_ICONS = {
        dashboard: '<svg viewBox="0 0 24 24"><path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4"/></svg>',
        train:     '<svg viewBox="0 0 24 24"><path d="M6.5 6.5h11M6.5 17.5h11M4 6.5a2.5 2.5 0 110 5M4 12.5a2.5 2.5 0 100 5M20 6.5a2.5 2.5 0 100 5M20 12.5a2.5 2.5 0 110 5M12 4v16"/></svg>',
        progress:  '<svg viewBox="0 0 24 24"><path d="M3 20l5-8 4 4 5-10 4 6"/></svg>',
        routines:  '<svg viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>',
        body:      '<svg viewBox="0 0 24 24"><path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>'
    };

    const TABS = [
        { id: 'dashboard', label: 'Dashboard' },
        { id: 'train',     label: 'Train' },
        { id: 'progress',  label: 'Progress' },
        { id: 'routines',  label: 'Routines' },
        { id: 'body',      label: 'Body' }
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
    function showToast(msg) {
        const t = document.createElement('div');
        t.className = 'gym-toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2200);
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
            if (dates.includes(check)) {
                streak++;
            } else if (i > 0) {
                break;
            }
            d.setDate(d.getDate() - 1);
        }
        return streak;
    }

    /* ── Total volume ever ── */
    function getTotalVolume(playerId) {
        const workouts = GymService.getWorkouts(playerId);
        let total = 0;
        workouts.forEach(w => { total += GymService.getWorkoutVolume(w); });
        return total;
    }

    /* ── 3D Character (exact BusinessWorld character) ── */
    function createGymCharacter(color) {
        color = color || 0x3498db;
        const THREE = window.THREE;
        const g = new THREE.Group();
        const cMat = new THREE.ShaderMaterial({
            uniforms: { uColor: { value: new THREE.Color(color) }, uRim: { value: new THREE.Color(0xffffff) }, uRimPow: { value: 2.5 } },
            vertexShader: 'varying vec3 vN,vV;void main(){vN=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.0);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}',
            fragmentShader: 'uniform vec3 uColor,uRim;uniform float uRimPow;varying vec3 vN,vV;void main(){float rim=1.0-max(0.0,dot(normalize(vN),normalize(vV)));rim=pow(rim,uRimPow)*0.6;vec3 col=uColor+uRim*rim;float NdotL=max(0.0,dot(normalize(vN),normalize(vec3(1,2,1))));col*=0.5+0.5*NdotL;gl_FragColor=vec4(col,1.0);}'
        });
        // Body
        var body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 1, 16), cMat);
        body.position.y = 0.5; g.add(body);
        var top = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 16, 0, Math.PI*2, 0, Math.PI/2), cMat);
        top.position.y = 1; g.add(top);
        // Neck
        var neck = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 0.2, 12), cMat);
        neck.position.y = 1.2; g.add(neck);
        // Head
        var head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 20, 20), cMat);
        head.position.y = 1.65; g.add(head);
        // Eyes
        var eyeM = new THREE.MeshBasicMaterial({ color: 0x1a1a2e });
        var eyeW = new THREE.MeshBasicMaterial({ color: 0xffffff });
        [[-0.15, 1.72, 0.3],[0.15, 1.72, 0.3]].forEach(function(pos) {
            var x = pos[0], y = pos[1], z = pos[2];
            var ew = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 10), eyeW);
            ew.position.set(x,y,z); g.add(ew);
            var ep = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 10), eyeM);
            ep.position.set(x,y,z+0.04); g.add(ep);
            var eh = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 6), eyeW);
            eh.position.set(x+0.03,y+0.03,z+0.08); g.add(eh);
        });
        // Base
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
        canvas.width = size * 2;
        canvas.height = size * 2;
        canvas.style.width = size + 'px';
        canvas.style.height = size + 'px';
        wrap.appendChild(canvas);

        const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
        renderer.setSize(size, size);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setClearColor(0x000000, 0);
        gymCharacterRenderer = renderer;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
        camera.position.set(0, 1.8, 4.5);
        camera.lookAt(0, 1, 0);

        // Lights
        const ambient = new THREE.AmbientLight(0xfff0e0, 1.2);
        scene.add(ambient);
        const dir = new THREE.DirectionalLight(0xfff8f0, 1.5);
        dir.position.set(3, 8, 5);
        scene.add(dir);

        const charGroup = createGymCharacter(0x3498db);
        scene.add(charGroup);

        function animate() {
            characterAnimFrame = requestAnimationFrame(animate);
            charGroup.rotation.y += 0.008;
            renderer.render(scene, camera);
        }
        animate();
    }

    function disposeCharacter() {
        if (characterAnimFrame) {
            cancelAnimationFrame(characterAnimFrame);
            characterAnimFrame = null;
        }
        if (gymCharacterRenderer) {
            gymCharacterRenderer.dispose();
            gymCharacterRenderer = null;
        }
    }

    /* ── SVG Line Chart ── */
    function renderLineChart(dataPoints, w, h, label) {
        w = w || 600; h = h || 200;
        if (dataPoints.length < 2) {
            return '<div class="gym-empty">Not enough data for chart<span class="gym-empty-dash"></span></div>';
        }
        const values = dataPoints.map(d => d.value);
        const min = Math.min(...values);
        const max = Math.max(...values);
        const range = max - min || 1;
        const padL = 45, padR = 15, padT = 20, padB = 35;
        const cw = w - padL - padR, ch = h - padT - padB;

        let gridLines = '';
        const steps = 4;
        for (let i = 0; i <= steps; i++) {
            const y = padT + (i / steps) * ch;
            const val = max - (i / steps) * range;
            gridLines += '<line x1="' + padL + '" y1="' + y + '" x2="' + (w - padR) + '" y2="' + y + '" stroke="#e8ddd0" stroke-width="1"/>';
            gridLines += '<text x="' + (padL - 8) + '" y="' + (y + 4) + '" fill="#999" font-size="10" text-anchor="end" font-family="var(--gym-font-mono)">' + Math.round(val) + '</text>';
        }

        const pts = dataPoints.map((d, i) => {
            const x = padL + (i / (dataPoints.length - 1)) * cw;
            const y = padT + ((max - d.value) / range) * ch;
            return { x, y };
        });

        const linePoints = pts.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');

        let lineLen = 0;
        for (let i = 1; i < pts.length; i++) {
            const dx = pts[i].x - pts[i-1].x;
            const dy = pts[i].y - pts[i-1].y;
            lineLen += Math.sqrt(dx * dx + dy * dy);
        }

        let xLabels = '';
        const labelStep = Math.max(1, Math.floor(dataPoints.length / 6));
        dataPoints.forEach((d, i) => {
            if (i % labelStep === 0 || i === dataPoints.length - 1) {
                const x = padL + (i / (dataPoints.length - 1)) * cw;
                xLabels += '<text x="' + x + '" y="' + (h - 8) + '" fill="#999" font-size="10" text-anchor="middle">' + fmtDate(d.date) + '</text>';
            }
        });

        let dots = '';
        pts.forEach((p, i) => {
            const delay = (i / pts.length) * 1.2;
            dots += '<circle class="gym-chart-dot" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="4" fill="#5a3e1b" style="animation-delay:' + delay.toFixed(2) + 's"/>';
        });

        return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet">' +
            gridLines +
            '<polyline class="gym-chart-line" points="' + linePoints + '" fill="none" stroke="#5a3e1b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="stroke-dasharray:' + Math.ceil(lineLen) + ';stroke-dashoffset:' + Math.ceil(lineLen) + ';--line-length:' + Math.ceil(lineLen) + '"/>' +
            dots +
            xLabels +
            (label ? '<text x="' + (w / 2) + '" y="14" fill="#999" font-size="11" text-anchor="middle">' + esc(label) + '</text>' : '') +
        '</svg>';
    }

    /* ── Player Selector ── */
    function renderPlayerSelector() {
        return GymService.getPlayers().map((p, idx) => {
            const grad = PLAYER_GRADIENTS[idx % PLAYER_GRADIENTS.length];
            const initial = p.name.charAt(0).toUpperCase();
            return '<div class="gym-player-avatar ' + (p.id === activePlayer ? 'active' : '') + '" data-player="' + esc(p.id) + '">' +
                '<div class="gym-player-avatar-circle" style="background:linear-gradient(135deg,' + grad[0] + ',' + grad[1] + ')">' + initial + '</div>' +
                '<div class="gym-player-avatar-name">' + esc(p.name) + '</div>' +
            '</div>';
        }).join('');
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
        const totalWorkouts = GymService.getTotalWorkouts(pid);
        const level = Math.max(1, Math.floor(totalWorkouts / 10));
        const streak = getStreak(pid);
        const totalVol = getTotalVolume(pid);
        const recent = GymService.getWorkouts(pid, 3);

        let html = '';

        // Character section
        html += '<div class="gym-character-section">' +
            '<div class="gym-character-canvas-wrap" id="gym-char-canvas"></div>' +
            '<div class="gym-character-name">' + esc(playerName) + '</div>' +
        '</div>';

        // Stat grid
        html += '<div class="gym-stat-grid">' +
            '<div class="gym-stat-box"><div class="gym-stat-box-value">' + level + '</div><div class="gym-stat-box-label">Level</div></div>' +
            '<div class="gym-stat-box"><div class="gym-stat-box-value">' + totalWorkouts + '</div><div class="gym-stat-box-label">Workouts</div></div>' +
            '<div class="gym-stat-box"><div class="gym-stat-box-value">' + streak + '</div><div class="gym-stat-box-label">Streak</div></div>' +
            '<div class="gym-stat-box"><div class="gym-stat-box-value">' + fmtVolume(totalVol) + '</div><div class="gym-stat-box-label">Total Volume</div></div>' +
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

        // Quick actions
        const nextRoutineId = GymService.getNextRoutine(pid);
        html += '<div class="gym-actions-row">' +
            '<button class="gym-btn-primary" data-action="start-workout" data-routine="' + nextRoutineId + '">START WORKOUT</button>' +
            '<button class="gym-btn-outline" data-action="goto-body">LOG WEIGHT</button>' +
        '</div>';

        return html;
    }

    /* ══════════════════════════════════════════
       TAB 2: TRAIN
    ══════════════════════════════════════════ */
    function renderTrain() {
        const pid = activePlayer;
        const routines = GymService.getRoutines();
        let html = '';

        // Routine selection
        html += '<div class="gym-routine-grid">';
        routines.forEach(r => {
            const color = ROUTINE_COLORS[r.id] || 'gold';
            const exCount = r.exercises ? r.exercises.length : 0;
            html += '<div class="gym-routine-card ' + (selectedRoutineId === r.id ? 'selected' : '') + '" data-routine="' + esc(r.id) + '" data-color="' + color + '">' +
                '<div class="gym-routine-card-name">' + esc(r.name) + '</div>' +
                '<div class="gym-routine-card-desc">' + esc(r.description) + '</div>' +
                '<div class="gym-routine-card-count">' + exCount + ' exercises</div>' +
            '</div>';
        });
        html += '</div>';

        if (selectedRoutineId) {
            const routine = GymService.getRoutine(selectedRoutineId);
            if (routine) {
                // Workout header with timer
                const elapsed = workoutStartTime ? Date.now() - workoutStartTime : 0;
                html += '<div class="gym-workout-header">' +
                    '<div class="gym-workout-title">' + esc(routine.name) + '</div>' +
                    '<div class="gym-workout-timer" id="gym-timer">' + fmtTimer(elapsed) + '</div>' +
                '</div>';

                html += '<div class="gym-exercise-list">';
                routine.exercises.forEach((re, reIdx) => {
                    const exDef = GymService.getExercise(re.exerciseId);
                    if (!exDef) return;
                    const prog = GymService.getProgressionSuggestion(pid, re.exerciseId);
                    const lastW = GymService.getLastWeight(pid, re.exerciseId);
                    const history = GymService.getExerciseHistory(pid, re.exerciseId, 3);
                    const suggestedWeight = prog.suggest ? prog.weight : (lastW || re.defaultWeight || 0);

                    html += '<div class="gym-exercise-card">' +
                        '<div class="gym-exercise-header">' +
                            '<div>' +
                                '<div class="gym-exercise-name">' + esc(exDef.name) + '</div>' +
                                '<span class="gym-category-pill ' + exDef.category + '">' + exDef.category.toUpperCase() + '</span>' +
                            '</div>' +
                            (prog.suggest ? '<span class="gym-overload-badge">INCREASE WEIGHT</span>' : '') +
                        '</div>' +
                        '<div class="gym-set-rows">';

                    for (let s = 0; s < re.sets; s++) {
                        const setKey = reIdx + '-' + s;
                        const saved = logState.sets[setKey] || {};
                        const w = saved.weight !== undefined ? saved.weight : suggestedWeight;
                        const reps = saved.reps !== undefined ? saved.reps : '';
                        const done = saved.completed || false;
                        html += '<div class="gym-set-row">' +
                            '<span class="gym-set-num">S' + (s + 1) + '</span>' +
                            '<input type="number" class="gym-set-input gym-set-weight" data-set="' + setKey + '" value="' + w + '" placeholder="lb">' +
                            '<span class="gym-set-x">x</span>' +
                            '<input type="number" class="gym-set-input gym-set-reps" data-set="' + setKey + '" value="' + reps + '" placeholder="reps">' +
                            '<button class="gym-set-check ' + (done ? 'done' : '') + '" data-set="' + setKey + '">&#10003;</button>' +
                        '</div>';
                    }

                    html += '</div>';

                    if (history.length > 0) {
                        const histStr = history.map(h => h.weight + ' x ' + (h.reps || '?')).join(', ');
                        html += '<div class="gym-exercise-history">Last session: ' + histStr + '</div>';
                    }

                    html += '</div>';
                });
                html += '</div>';

                // Bottom bar
                html += '<div class="gym-log-bottom">' +
                    '<div class="gym-feeling-row">' +
                        '<span class="gym-feeling-label">Feeling</span>' +
                        '<div class="gym-feeling-btns">';
                for (let i = 1; i <= 5; i++) {
                    html += '<button class="gym-feeling-btn ' + (logState.feeling === i ? 'active' : '') + '" data-feeling="' + i + '">' + i + '</button>';
                }
                html += '</div>' +
                    '</div>' +
                    '<textarea class="gym-log-notes" placeholder="Notes..." data-field="notes">' + esc(logState.notes) + '</textarea>' +
                    '<button class="gym-btn-full" data-action="save-workout">FINISH WORKOUT</button>' +
                '</div>';
            }
        }
        return html;
    }

    /* ══════════════════════════════════════════
       TAB 3: PROGRESS
    ══════════════════════════════════════════ */
    function renderProgress() {
        const pid = activePlayer;
        const exercises = GymService.getExercises();

        // Metric pills
        let html = '<div class="gym-metric-pills">';
        html += '<button class="gym-metric-pill ' + (progressMetric === 'weight' ? 'active' : '') + '" data-metric="weight">Body Weight</button>';
        exercises.forEach(e => {
            html += '<button class="gym-metric-pill ' + (progressMetric === e.id ? 'active' : '') + '" data-metric="' + esc(e.id) + '">' + esc(e.name) + '</button>';
        });
        html += '</div>';

        // Chart
        html += '<div class="gym-chart-container">';
        if (progressMetric === 'weight') {
            const weights = GymService.getWeights(pid);
            if (weights.length >= 2) {
                html += renderLineChart(weights, 600, 200, 'Bodyweight (lb)');
            } else {
                html += '<div class="gym-empty">Log at least 2 weight entries to see a chart<span class="gym-empty-dash"></span></div>';
            }
        } else {
            const progression = GymService.getExerciseProgression(pid, progressMetric);
            const exDef = GymService.getExercise(progressMetric);
            if (progression.length >= 2) {
                html += renderLineChart(progression, 600, 200, (exDef ? exDef.name : '') + ' (lb)');
            } else {
                html += '<div class="gym-empty">Log at least 2 sessions to see progression<span class="gym-empty-dash"></span></div>';
            }
        }
        html += '</div>';

        // PRs
        if (progressMetric !== 'weight') {
            const prs = GymService.getPRs(pid, progressMetric);
            if (prs.length > 0) {
                html += '<div class="gym-pr-section"><div class="gym-section-title">Personal Records</div><div class="gym-pr-cards">';
                prs.forEach((pr, i) => {
                    html += '<div class="gym-pr-card">' +
                        '<div class="gym-pr-card-rank">#' + (i + 1) + '</div>' +
                        '<div class="gym-pr-card-weight">' + pr.weight + 'lb</div>' +
                        '<div class="gym-pr-card-detail">' + pr.reps + ' reps -- ' + fmtDate(pr.date) + '</div>' +
                        '<span class="gym-pr-badge-tag">PR</span>' +
                    '</div>';
                });
                html += '</div></div>';
            }
        }

        // Challenges
        html += '<div class="gym-section-title">Challenges</div>' +
            '<button class="gym-btn-sm outline" data-action="toggle-challenge-form">ADD CHALLENGE</button>';

        if (showChallengeForm) {
            html += '<div class="gym-challenge-form">' +
                '<input type="text" class="gym-input wide" id="gym-challenge-name" placeholder="Challenge name">' +
                '<input type="number" class="gym-input num" id="gym-challenge-value" placeholder="Value">' +
                '<input type="text" class="gym-input" id="gym-challenge-unit" placeholder="Unit" style="width:80px">' +
                '<input type="date" class="gym-input" id="gym-challenge-date" value="' + today() + '">' +
                '<button class="gym-btn-sm" data-action="save-challenge">Save</button>' +
            '</div>';
        }

        const challenges = GymService.getChallenges(pid);
        if (challenges.length > 0) {
            html += '<div class="gym-challenge-list">';
            challenges.forEach(c => {
                html += '<div class="gym-challenge-item">' +
                    '<span class="gym-challenge-name">' + esc(c.name) + '</span>' +
                    '<span class="gym-challenge-val">' + esc(String(c.value)) + ' ' + esc(c.unit) + '</span>' +
                    '<span class="gym-challenge-date">' + fmtDate(c.date) + '</span>' +
                '</div>';
            });
            html += '</div>';
        }
        return html;
    }

    /* ══════════════════════════════════════════
       TAB 4: ROUTINES
    ══════════════════════════════════════════ */
    function renderRoutines() {
        const routines = GymService.getRoutines();
        const settings = GymService.getSettings();

        let html = '<div class="gym-routines-header">' +
            '<div class="gym-section-title" style="margin:0">Programs</div>' +
            '<button class="gym-btn-sm outline" data-action="add-routine">NEW ROUTINE</button>' +
        '</div>';

        routines.forEach(r => {
            const isEditing = editingRoutineId === r.id;
            const colorHex = ROUTINE_COLOR_HEX[r.id] || '#e8a020';
            html += '<div class="gym-routine-detail">' +
                '<div class="gym-routine-detail-header">' +
                    '<div>' +
                        '<div class="gym-routine-detail-name">' +
                            '<span class="gym-routine-color-dot" style="background:' + colorHex + '"></span>' + esc(r.name) +
                        '</div>' +
                        '<div class="gym-routine-detail-desc">' + esc(r.description) + ' <span class="gym-routine-exercise-count">' + r.exercises.length + ' exercises</span></div>' +
                    '</div>' +
                    '<div style="display:flex;gap:4px;">' +
                        '<button class="gym-icon-btn" data-action="edit-routine" data-routine="' + esc(r.id) + '" title="Edit">' +
                            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
                        '</button>' +
                        '<button class="gym-icon-btn danger" data-action="delete-routine" data-routine="' + esc(r.id) + '" title="Delete">' +
                            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
                        '</button>' +
                    '</div>' +
                '</div>' +
                '<div class="gym-routine-exercises">';
            r.exercises.forEach(re => {
                const exDef = GymService.getExercise(re.exerciseId);
                html += '<div class="gym-routine-exercise-row">' +
                    '<span class="gym-routine-exercise-name">' + (exDef ? esc(exDef.name) : esc(re.exerciseId)) + '</span>' +
                    '<span class="gym-routine-exercise-detail">' + re.sets + 's @ ' + re.defaultWeight + 'lb</span>' +
                '</div>';
            });
            html += '</div>';
            if (isEditing) {
                html += renderRoutineEditor(r);
            }
            html += '</div>';
        });

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
        '</div>';

        return html;
    }

    function renderRoutineEditor(routine) {
        const allExercises = GymService.getExercises();
        let html = '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--gym-border)">' +
            '<div class="gym-inline-form">' +
                '<input type="text" class="gym-input wide" placeholder="Routine name" value="' + esc(routine.name) + '" data-edit="name">' +
                '<input type="text" class="gym-input wide" placeholder="Description" value="' + esc(routine.description) + '" data-edit="description">' +
                '<button class="gym-btn-sm" data-action="save-routine-edit" data-routine="' + esc(routine.id) + '">Save</button>' +
            '</div>' +
            '<div style="margin-top:8px">' +
                '<select class="gym-input" data-action="add-exercise-to-routine" data-routine="' + esc(routine.id) + '" style="width:100%">' +
                    '<option value="">Add exercise...</option>';
        allExercises.forEach(e => {
            html += '<option value="' + esc(e.id) + '">' + esc(e.name) + '</option>';
        });
        html += '</select>' +
            '</div>' +
        '</div>';
        return html;
    }

    /* ══════════════════════════════════════════
       TAB 5: BODY
    ══════════════════════════════════════════ */
    function renderBody() {
        const pid = activePlayer;
        let html = '';

        // Weight section
        const weights = GymService.getWeights(pid);
        const currentWeight = weights.length ? weights[weights.length - 1].value : null;

        html += '<div class="gym-body-section">' +
            '<div class="gym-body-section-title">Weight Tracker</div>';
        if (currentWeight !== null) {
            html += '<div class="gym-current-weight">' +
                '<span class="gym-current-weight-val">' + currentWeight + '</span>' +
                '<span class="gym-current-weight-unit">lbs</span>' +
            '</div>';
        }
        html += '<div class="gym-form-row">' +
                '<input type="number" class="gym-input num" id="gym-weight-val" placeholder="lbs" step="0.1">' +
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
                html += '<tr><td>' + fmtDate(w.date) + '</td><td>' + w.value + ' lb</td><td>' + delta + '</td></tr>';
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

        // Diet section
        html += '<div class="gym-body-section">' +
            '<div class="gym-body-section-title">Diet Log</div>' +
            '<div class="gym-form-row">' +
                '<input type="text" class="gym-input wide" id="gym-diet-name" placeholder="Food item">' +
                '<input type="number" class="gym-input num" id="gym-diet-cal" placeholder="kcal">' +
                '<input type="number" class="gym-input num" id="gym-diet-protein" placeholder="prot">' +
                '<input type="number" class="gym-input num" id="gym-diet-carbs" placeholder="carbs">' +
                '<input type="number" class="gym-input num" id="gym-diet-fat" placeholder="fat">' +
                '<button class="gym-btn-sm" data-action="save-diet">Add</button>' +
            '</div>';

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
            const maxCal = 2500;
            html += '<div class="gym-diet-summary">' +
                '<div class="gym-diet-bar-card">' +
                    '<div class="gym-diet-bar-val">' + totalCal + '</div>' +
                    '<div class="gym-diet-bar-label">Calories</div>' +
                    '<div class="gym-diet-bar-fill"><div class="gym-diet-bar-fill-inner" style="width:' + Math.min(100, (totalCal / maxCal) * 100) + '%;background:#e8a020"></div></div>' +
                '</div>' +
                '<div class="gym-diet-bar-card">' +
                    '<div class="gym-diet-bar-val">' + totalP + 'g</div>' +
                    '<div class="gym-diet-bar-label">Protein</div>' +
                    '<div class="gym-diet-bar-fill"><div class="gym-diet-bar-fill-inner" style="width:' + Math.min(100, (totalP / 180) * 100) + '%;background:#0984e3"></div></div>' +
                '</div>' +
                '<div class="gym-diet-bar-card">' +
                    '<div class="gym-diet-bar-val">' + totalC + 'g</div>' +
                    '<div class="gym-diet-bar-label">Carbs</div>' +
                    '<div class="gym-diet-bar-fill"><div class="gym-diet-bar-fill-inner" style="width:' + Math.min(100, (totalC / 300) * 100) + '%;background:#2ecc71"></div></div>' +
                '</div>' +
                '<div class="gym-diet-bar-card">' +
                    '<div class="gym-diet-bar-val">' + totalF + 'g</div>' +
                    '<div class="gym-diet-bar-label">Fat</div>' +
                    '<div class="gym-diet-bar-fill"><div class="gym-diet-bar-fill-inner" style="width:' + Math.min(100, (totalF / 80) * 100) + '%;background:#e74c3c"></div></div>' +
                '</div>' +
            '</div>';

            html += '<div class="gym-diet-items">';
            todayDiet.forEach(d => {
                (d.items || []).forEach(item => {
                    html += '<div class="gym-diet-item">' +
                        '<span class="gym-diet-item-name">' + esc(item.name) + '</span>' +
                        '<span class="gym-diet-item-macros">' + item.calories + 'cal ' + item.protein + 'p ' + item.carbs + 'c ' + item.fat + 'f</span>' +
                    '</div>';
                });
            });
            html += '</div>';
        }
        html += '</div>';
        return html;
    }

    /* ══════════════════════════════════════════
       MAIN RENDER
    ══════════════════════════════════════════ */
    function render() {
        return '<div class="gym-panel">' +
            '<div class="gym-header">' +
                '<div class="gym-header-title">Gym</div>' +
                '<div class="gym-player-selector">' + renderPlayerSelector() + '</div>' +
            '</div>' +
            '<div class="gym-tabs">' + renderTabs() + '</div>' +
            '<div class="gym-tab-content" id="gym-tab-content"></div>' +
        '</div>';
    }

    function renderActiveTab() {
        const el = container && container.querySelector('#gym-tab-content');
        if (!el) return;
        disposeCharacter();
        switch (activeTab) {
            case 'dashboard': el.innerHTML = renderDashboard(); initDashboard(); break;
            case 'train':     el.innerHTML = renderTrain(); startTimerTick(); break;
            case 'progress':  el.innerHTML = renderProgress(); break;
            case 'routines':  el.innerHTML = renderRoutines(); break;
            case 'body':      el.innerHTML = renderBody(); break;
        }
        bindTabEvents();
    }

    function initDashboard() {
        const wrap = container && container.querySelector('#gym-char-canvas');
        if (wrap) {
            initCharacterCanvas(wrap);
        }
    }

    function startTimerTick() {
        clearInterval(timerInterval);
        if (!workoutStartTime || !selectedRoutineId) return;
        timerInterval = setInterval(() => {
            const el = container && container.querySelector('#gym-timer');
            if (el) el.textContent = fmtTimer(Date.now() - workoutStartTime);
        }, 1000);
    }

    /* ── Event Binding ── */
    function bindEvents() {
        if (!container) return;

        container.querySelectorAll('.gym-tab').forEach(el => {
            el.addEventListener('click', () => {
                activeTab = el.dataset.tab;
                container.querySelectorAll('.gym-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
                renderActiveTab();
            });
        });

        container.querySelectorAll('.gym-player-avatar').forEach(el => {
            el.addEventListener('click', () => {
                activePlayer = el.dataset.player;
                container.querySelectorAll('.gym-player-avatar').forEach(c => c.classList.toggle('active', c.dataset.player === activePlayer));
                renderActiveTab();
            });
        });

        renderActiveTab();
    }

    function bindTabEvents() {
        if (!container) return;
        const content = container.querySelector('#gym-tab-content');
        if (!content) return;

        // Dashboard: start workout
        content.querySelectorAll('[data-action="start-workout"]').forEach(el => {
            el.addEventListener('click', () => {
                selectedRoutineId = el.dataset.routine;
                activeTab = 'train';
                container.querySelectorAll('.gym-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'train'));
                logState = { feeling: 3, notes: '', sets: {} };
                workoutStartTime = Date.now();
                renderActiveTab();
            });
        });

        // Dashboard: log weight shortcut
        content.querySelectorAll('[data-action="goto-body"]').forEach(el => {
            el.addEventListener('click', () => {
                activeTab = 'body';
                container.querySelectorAll('.gym-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'body'));
                renderActiveTab();
            });
        });

        // Train: routine selection
        content.querySelectorAll('.gym-routine-card').forEach(el => {
            el.addEventListener('click', () => {
                selectedRoutineId = el.dataset.routine;
                logState = { feeling: 3, notes: '', sets: {} };
                workoutStartTime = Date.now();
                renderActiveTab();
            });
        });

        // Train: set inputs
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

        // Train: feeling
        content.querySelectorAll('.gym-feeling-btn').forEach(el => {
            el.addEventListener('click', () => {
                logState.feeling = parseInt(el.dataset.feeling);
                content.querySelectorAll('.gym-feeling-btn').forEach(b => b.classList.toggle('active', b.dataset.feeling === el.dataset.feeling));
            });
        });

        // Train: notes
        const notesEl = content.querySelector('[data-field="notes"]');
        if (notesEl) notesEl.addEventListener('input', () => { logState.notes = notesEl.value; });

        // Train: save workout
        content.querySelectorAll('[data-action="save-workout"]').forEach(el => {
            el.addEventListener('click', saveWorkout);
        });

        // Progress: metric pills
        content.querySelectorAll('.gym-metric-pill').forEach(el => {
            el.addEventListener('click', () => {
                progressMetric = el.dataset.metric;
                renderActiveTab();
            });
        });

        // Progress: challenge form toggle
        content.querySelectorAll('[data-action="toggle-challenge-form"]').forEach(el => {
            el.addEventListener('click', () => {
                showChallengeForm = !showChallengeForm;
                renderActiveTab();
            });
        });

        // Progress: save challenge
        content.querySelectorAll('[data-action="save-challenge"]').forEach(el => {
            el.addEventListener('click', () => {
                const name = document.getElementById('gym-challenge-name');
                const value = document.getElementById('gym-challenge-value');
                const unit = document.getElementById('gym-challenge-unit');
                const date = document.getElementById('gym-challenge-date');
                if (!name || !name.value || !value || !value.value) return;
                GymService.addChallenge(activePlayer, {
                    name: name.value,
                    value: parseFloat(value.value) || 0,
                    unit: unit ? unit.value : '',
                    date: date ? date.value : today()
                });
                showChallengeForm = false;
                showToast('Challenge added');
                renderActiveTab();
            });
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

        // Routines: add new
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
                const key = reIdx + '-' + s;
                const saved = logState.sets[key] || {};
                const weightInput = container.querySelector('.gym-set-weight[data-set="' + key + '"]');
                const repsInput = container.querySelector('.gym-set-reps[data-set="' + key + '"]');
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
            feeling: logState.feeling
        };

        GymService.logWorkout(activePlayer, workout);
        logState = { feeling: 3, notes: '', sets: {} };
        workoutStartTime = null;
        clearInterval(timerInterval);
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
            disposeCharacter();
            clearInterval(timerInterval);
            container = null;
            activeTab = 'dashboard';
            selectedRoutineId = null;
            logState = { feeling: 3, notes: '', sets: {} };
            editingRoutineId = null;
            workoutStartTime = null;
            showChallengeForm = false;
        }
    };
})();

BuildingRegistry.register('Gym', {
    open: (bodyEl, opts) => GymUI.open(bodyEl, opts),
    close: () => GymUI.close()
});
