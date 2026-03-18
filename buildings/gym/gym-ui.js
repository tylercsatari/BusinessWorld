/* ── Gym UI ── BusinessWorld Warm Aesthetic ── Research-Backed Fitness Tracker ── */
const GymUI = (() => {
    let container = null;
    let activeTab = 'dashboard';
    let activePlayer = 'tyler';
    let selectedRoutineId = null;
    let trainStep = 'choose'; // 'choose' | 'workout'
    let logState = {
        sessionRPE: 5, energyLevel: 3, sleepHours: 7, sleepQuality: 3,
        stressLevel: 2, hydration: 'good', preWorkoutFed: 'yes',
        notes: '', sets: {}, exerciseNotes: {}, exerciseMMC: {}
    };
    let progressMetric = 'weight';
    let editingRoutineId = null;
    let workoutStartTime = null;
    let timerInterval = null;
    let gymCharacterRenderer = null;
    let characterAnimFrame = null;
    let showChallengeForm = false;
    let showGoalForm = false;
    let showGoalSelector = false;
    let showMeasurementForm = false;
    let showLevelTooltip = false;

    const ROUTINE_COLORS = { upper1: 'gold', lower1: 'blue', upper2: 'green', lower2: 'red' };
    const ROUTINE_COLOR_HEX = { upper1: '#e8a020', lower1: '#0984e3', upper2: '#2ecc71', lower2: '#e74c3c' };

    const GOAL_LABELS = {
        general: 'General Fitness', muscle: 'Muscle Mass', strength: 'Strength',
        fatloss: 'Fat Loss', recomp: 'Recomposition'
    };

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

    /* ── SVG Line Chart ── */
    function renderLineChart(dataPoints, w, h, label, goalValue) {
        w = w || 600; h = h || 200;
        if (dataPoints.length < 2) {
            return '<div class="gym-empty">Not enough data for chart<span class="gym-empty-dash"></span></div>';
        }
        const values = dataPoints.map(d => d.value);
        let min = Math.min(...values);
        let max = Math.max(...values);
        if (goalValue != null) {
            min = Math.min(min, goalValue);
            max = Math.max(max, goalValue);
        }
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

        // Goal line
        let goalLine = '';
        if (goalValue != null) {
            const gy = padT + ((max - goalValue) / range) * ch;
            goalLine = '<line x1="' + padL + '" y1="' + gy + '" x2="' + (w - padR) + '" y2="' + gy + '" stroke="#e8a020" stroke-width="1.5" stroke-dasharray="6,4"/>' +
                '<text x="' + (w - padR) + '" y="' + (gy - 4) + '" fill="#e8a020" font-size="10" text-anchor="end">Goal</text>';
        }

        const pts = dataPoints.map((d, i) => {
            const x = padL + (i / (dataPoints.length - 1)) * cw;
            const y = padT + ((max - d.value) / range) * ch;
            return { x, y };
        });
        const linePoints = pts.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
        let lineLen = 0;
        for (let i = 1; i < pts.length; i++) {
            const dx = pts[i].x - pts[i-1].x, dy = pts[i].y - pts[i-1].y;
            lineLen += Math.sqrt(dx * dx + dy * dy);
        }

        // Trend line (linear regression)
        let trendLine = '';
        if (pts.length >= 3) {
            const n = dataPoints.length;
            let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
            dataPoints.forEach((d, i) => { sumX += i; sumY += d.value; sumXY += i * d.value; sumX2 += i * i; });
            const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
            const intercept = (sumY - slope * sumX) / n;
            const ty1 = padT + ((max - intercept) / range) * ch;
            const ty2 = padT + ((max - (intercept + slope * (n - 1))) / range) * ch;
            trendLine = '<line x1="' + padL + '" y1="' + ty1.toFixed(1) + '" x2="' + (padL + cw) + '" y2="' + ty2.toFixed(1) + '" stroke="rgba(232,192,122,0.4)" stroke-width="1.5" stroke-dasharray="4,3"/>';
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
            gridLines + goalLine + trendLine +
            '<polyline class="gym-chart-line" points="' + linePoints + '" fill="none" stroke="#5a3e1b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="stroke-dasharray:' + Math.ceil(lineLen) + ';stroke-dashoffset:' + Math.ceil(lineLen) + ';--line-length:' + Math.ceil(lineLen) + '"/>' +
            dots + xLabels +
            (label ? '<text x="' + (w / 2) + '" y="14" fill="#999" font-size="11" text-anchor="middle">' + esc(label) + '</text>' : '') +
        '</svg>';
    }

    /* ── Player Selector (chips with character colors) ── */
    function renderPlayerSelector() {
        return GymService.getPlayers().map(p => {
            const hex = playerColorHex(p.id);
            const initial = p.name.charAt(0).toUpperCase();
            return '<div class="gym-player-avatar ' + (p.id === activePlayer ? 'active' : '') + '" data-player="' + esc(p.id) + '">' +
                '<div class="gym-player-avatar-circle" style="background:' + hex + '">' + initial + '</div>' +
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
        const levelInfo = GymService.getPlayerLevel(pid);
        const totalWorkouts = GymService.getTotalWorkouts(pid);
        const weekWorkouts = GymService.getWorkoutsThisWeek(pid);
        const streak = getStreak(pid);
        const totalVol = getTotalVolume(pid);
        const recent = GymService.getWorkouts(pid, 3);
        const weights = GymService.getWeights(pid);
        const currentWeight = weights.length ? weights[weights.length - 1].value : '--';
        const goalType = player && player.goals ? player.goals.type : 'general';
        const goalLabel = GOAL_LABELS[goalType] || 'General Fitness';

        let html = '';

        // Character section
        html += '<div class="gym-character-section">' +
            '<div class="gym-character-canvas-wrap" id="gym-char-canvas"></div>' +
            '<div class="gym-character-name">' + esc(playerName) + '</div>' +
            '<span class="gym-goal-badge" data-action="toggle-goal-selector">' + esc(goalLabel.toUpperCase()) + '</span>' +
        '</div>';

        // Level progress (simple dots)
        let dotsHtml = '<span class="gym-level-progress-dots">';
        for (let i = 0; i < 5; i++) {
            dotsHtml += '<span class="gym-level-dot' + (i < levelInfo.workoutsInLevel ? ' filled' : '') + '"></span>';
        }
        dotsHtml += '</span>';
        html += '<div class="gym-level-progress">' +
            levelInfo.workoutsToNext + ' workout' + (levelInfo.workoutsToNext !== 1 ? 's' : '') +
            ' to Level ' + (levelInfo.level + 1) + dotsHtml +
        '</div>';

        // Inline goal selector (expands/collapses)
        if (showGoalSelector) {
            html += '<div class="gym-goal-selector">';
            ['general', 'muscle', 'strength', 'fatloss', 'recomp'].forEach(g => {
                const active = g === goalType ? ' active' : '';
                html += '<button class="gym-goal-chip' + active + '" data-goal-type="' + g + '">' + esc(GOAL_LABELS[g]) + '</button>';
            });
            html += '</div>';
        }

        // Stat grid (2x3 mobile, 3x2 desktop)
        html += '<div class="gym-stat-grid">' +
            '<div class="gym-stat-box" data-action="toggle-level-info" style="cursor:pointer"><div class="gym-stat-box-value">' + levelInfo.level + '</div><div class="gym-stat-box-label">Level</div></div>' +
            '<div class="gym-stat-box"><div class="gym-stat-box-value">' + weekWorkouts + '</div><div class="gym-stat-box-label">This Week</div></div>' +
            '<div class="gym-stat-box"><div class="gym-stat-box-value">' + streak + '</div><div class="gym-stat-box-label">Streak</div></div>' +
            '<div class="gym-stat-box"><div class="gym-stat-box-value">' + fmtVolume(totalVol) + '</div><div class="gym-stat-box-label">Total Volume</div></div>' +
            '<div class="gym-stat-box"><div class="gym-stat-box-value">' + currentWeight + '</div><div class="gym-stat-box-label">Body Weight</div></div>' +
            '<div class="gym-stat-box"><div class="gym-stat-box-value">' + totalWorkouts + '</div><div class="gym-stat-box-label">Workouts</div></div>' +
        '</div>';

        // Level tooltip (tap Level stat to toggle)
        if (showLevelTooltip) {
            const goalHints = {
                general: 'Stay consistent and track your workouts.',
                muscle: 'Aim for higher volume to maximize growth.',
                strength: 'Focus on progressive overload with heavier weights.',
                fatloss: 'Keep intensity up while maintaining a calorie deficit.',
                recomp: 'Balance strength training with moderate volume.'
            };
            html += '<div style="background:#2e2418;border:1px solid var(--gym-border);border-radius:var(--gym-radius-sm);padding:12px 14px;margin:0 0 8px;font-size:13px;color:var(--gym-text-body)">' +
                '<strong style="color:var(--gym-brown)">Level ' + levelInfo.level + '</strong> &mdash; ' +
                'Every 5 workouts = 1 level. You\'ve done ' + levelInfo.totalWorkouts + ' total. ' +
                levelInfo.workoutsToNext + ' more to reach Level ' + (levelInfo.level + 1) + '.' +
                '<br><em style="color:var(--gym-text-muted)">' + (goalHints[goalType] || goalHints.general) + '</em>' +
            '</div>';
        }

        // Quick Start
        const nextRoutineId = GymService.getNextRoutine(pid);
        const nextRoutine = GymService.getRoutine(nextRoutineId);
        html += '<div class="gym-actions-row">' +
            '<button class="gym-btn-primary" data-action="start-workout" data-routine="' + nextRoutineId + '">START ' + (nextRoutine ? esc(nextRoutine.name.toUpperCase()) : 'WORKOUT') + '</button>' +
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
                const rpeBadge = w.sessionRPE ? '<span class="gym-rpe-badge">RPE ' + w.sessionRPE + '</span>' : '';
                html += '<div class="gym-recent-card">' +
                    '<div class="gym-recent-dot" style="background:' + colorHex + '"></div>' +
                    '<div class="gym-recent-info">' +
                        '<div class="gym-recent-routine">' + (r ? esc(r.name) : 'Custom') + '</div>' +
                        '<div class="gym-recent-meta">' + relativeDate(w.date) + ' ' + rpeBadge + '</div>' +
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
        let html = '';

        if (trainStep === 'choose' || !selectedRoutineId) {
            // Step 1: Choose Routine (full-screen card picker)
            html += '<div class="gym-tab-content">';
            html += '<div class="gym-section-title">Choose Routine</div>';
            html += '<div class="gym-routine-picker">';
            routines.forEach(r => {
                const color = ROUTINE_COLORS[r.id] || 'gold';
                const colorHex = ROUTINE_COLOR_HEX[r.id] || '#e8a020';
                const exCount = r.exercises ? r.exercises.length : 0;
                const nextId = GymService.getNextRoutine(pid);
                const isNext = r.id === nextId;
                html += '<div class="gym-routine-pick-card ' + (isNext ? 'suggested' : '') + '" data-routine="' + esc(r.id) + '" data-color="' + color + '">' +
                    '<div class="gym-routine-pick-accent" style="background:' + colorHex + '"></div>' +
                    '<div class="gym-routine-pick-body">' +
                        '<div class="gym-routine-pick-name">' + esc(r.name) + '</div>' +
                        '<div class="gym-routine-pick-desc">' + esc(r.description) + '</div>' +
                        '<div class="gym-routine-pick-count">' + exCount + ' exercises</div>' +
                        (isNext ? '<span class="gym-routine-pick-next">UP NEXT</span>' : '') +
                    '</div>' +
                '</div>';
            });
            html += '</div>';
            html += '</div>';
            return html;
        }

        // Step 2: Active Workout View
        const routine = GymService.getRoutine(selectedRoutineId);
        if (!routine) return '<div class="gym-tab-content"><div class="gym-empty">Routine not found</div></div>';

        const elapsed = workoutStartTime ? Date.now() - workoutStartTime : 0;
        html += '<div class="gym-active-workout">';
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
                    '<div>' +
                        '<div class="gym-exercise-name">' + esc(exDef.name) + '</div>' +
                        '<span class="gym-category-pill ' + exDef.category + '">' + exDef.category.toUpperCase() + '</span>' +
                    '</div>' +
                    (prog.suggest ? '<span class="gym-overload-badge">ADD WEIGHT: try ' + prog.weight + 'lbs</span>' : '') +
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
                const setType = saved.setType || 'working';

                html += '<div class="gym-set-row">' +
                    '<span class="gym-set-num">' + (s + 1) + '</span>' +
                    '<input type="number" class="gym-set-input gym-set-weight" data-set="' + setKey + '" value="' + w + '" placeholder="lb" style="width:70px">' +
                    '<input type="number" class="gym-set-input gym-set-reps" data-set="' + setKey + '" value="' + reps + '" placeholder="reps" style="width:50px">' +
                    '<select class="gym-set-rir-select" data-set="' + setKey + '">' +
                        '<option value="0"' + (rir === 0 ? ' selected' : '') + '>0</option>' +
                        '<option value="1"' + (rir === 1 ? ' selected' : '') + '>1</option>' +
                        '<option value="2"' + (rir === 2 ? ' selected' : '') + '>2</option>' +
                        '<option value="3"' + (rir === 3 ? ' selected' : '') + '>3</option>' +
                        '<option value="4"' + (rir >= 4 ? ' selected' : '') + '>4+</option>' +
                    '</select>' +
                    '<button class="gym-set-check ' + (done ? 'done' : '') + '" data-set="' + setKey + '">&#10003;</button>' +
                '</div>';
            }
            html += '</div>';

            // Add set button
            html += '<button class="gym-add-set-btn" data-exercise-idx="' + reIdx + '" data-default-sets="' + re.sets + '">+ Add Set</button>';

            // Mind-muscle connection (per exercise)
            const mmc = logState.exerciseMMC[reIdx] || 0;
            html += '<div class="gym-mmc-row">' +
                '<span class="gym-mmc-label">Mind-Muscle</span>' +
                '<div class="gym-dot-selector">';
            for (let d = 1; d <= 5; d++) {
                html += '<button class="gym-dot-btn ' + (mmc === d ? 'active' : '') + '" data-mmc-idx="' + reIdx + '" data-val="' + d + '">' + d + '</button>';
            }
            html += '</div></div>';

            html += '</div>'; // end exercise card
        });
        html += '</div>'; // end exercise-list
        html += '</div>'; // end exercise-scroll

        // End of Workout bottom sheet
        html += '<div class="gym-active-workout-footer">' +
            '<div class="gym-endworkout-title">End of Workout</div>';

        // Session RPE (1-10)
        html += '<div class="gym-metric-row">' +
            '<span class="gym-metric-label">Session RPE</span>' +
            '<div class="gym-rpe-selector">';
        for (let i = 1; i <= 10; i++) {
            html += '<button class="gym-rpe-btn ' + (logState.sessionRPE === i ? 'active' : '') + '" data-rpe="' + i + '">' + i + '</button>';
        }
        html += '</div></div>';

        // Energy (1-5 dots)
        html += '<div class="gym-metric-row">' +
            '<span class="gym-metric-label">Energy</span>' +
            '<div class="gym-dot-selector">';
        for (let i = 1; i <= 5; i++) {
            html += '<button class="gym-dot-btn ' + (logState.energyLevel === i ? 'active' : '') + '" data-energy="' + i + '">' + i + '</button>';
        }
        html += '</div></div>';

        // Sleep last night
        html += '<div class="gym-metric-row">' +
            '<span class="gym-metric-label">Sleep (hrs)</span>' +
            '<input type="number" class="gym-set-input" data-field="sleepHours" value="' + logState.sleepHours + '" step="0.5" min="0" max="14" style="width:70px">' +
        '</div>';

        // Stress (1-5 dots)
        html += '<div class="gym-metric-row">' +
            '<span class="gym-metric-label">Stress</span>' +
            '<div class="gym-dot-selector">';
        for (let i = 1; i <= 5; i++) {
            html += '<button class="gym-dot-btn ' + (logState.stressLevel === i ? 'active' : '') + '" data-stress="' + i + '">' + i + '</button>';
        }
        html += '</div></div>';

        // Hydration (3 buttons)
        html += '<div class="gym-metric-row">' +
            '<span class="gym-metric-label">Hydration</span>' +
            '<div class="gym-hydration-btns">' +
                '<button class="gym-hydration-btn ' + (logState.hydration === 'good' ? 'active' : '') + '" data-hydration="good">Good</button>' +
                '<button class="gym-hydration-btn ' + (logState.hydration === 'ok' ? 'active' : '') + '" data-hydration="ok">OK</button>' +
                '<button class="gym-hydration-btn ' + (logState.hydration === 'poor' ? 'active' : '') + '" data-hydration="poor">Poor</button>' +
            '</div></div>';

        // Notes
        html += '<textarea class="gym-log-notes" placeholder="Session notes..." data-field="notes">' + esc(logState.notes) + '</textarea>';

        // FINISH button
        html += '<button class="gym-btn-finish" data-action="save-workout">FINISH</button>';
        html += '</div>'; // end gym-active-workout-footer
        html += '</div>'; // end gym-active-workout

        return html;
    }

    /* ══════════════════════════════════════════
       TAB 3: PROGRESS
    ══════════════════════════════════════════ */
    function renderProgress() {
        const pid = activePlayer;
        const player = GymService.getPlayer(pid);
        const exercises = GymService.getExercises();
        const settings = GymService.getSettings();
        const unit = settings.weightUnit || 'lbs';

        // Metric pills
        let html = '<div class="gym-metric-pills">';
        const metrics = [
            { id: 'weight', label: 'Body Weight' },
            { id: 'bodyfat', label: 'Body Fat %' },
            { id: 'bench_e1rm', label: 'Bench e1RM' },
            { id: 'squat_e1rm', label: 'Squat e1RM' },
            { id: 'weekly_volume', label: 'Weekly Volume' },
            { id: 'frequency', label: 'Workout Frequency' }
        ];
        metrics.forEach(m => {
            html += '<button class="gym-metric-pill ' + (progressMetric === m.id ? 'active' : '') + '" data-metric="' + m.id + '">' + m.label + '</button>';
        });
        exercises.forEach(e => {
            html += '<button class="gym-metric-pill ' + (progressMetric === e.id ? 'active' : '') + '" data-metric="' + esc(e.id) + '">' + esc(e.name) + '</button>';
        });
        html += '</div>';

        // Chart
        html += '<div class="gym-chart-container">';
        const goalWeight = player && player.goals && player.goals.targetWeight ? player.goals.targetWeight : null;

        if (progressMetric === 'weight') {
            const weights = GymService.getWeights(pid);
            if (weights.length >= 2) {
                html += renderLineChart(weights, 600, 200, 'Bodyweight (' + unit + ')', goalWeight);
            } else {
                html += '<div class="gym-empty">Log at least 2 weight entries<span class="gym-empty-dash"></span></div>';
            }
        } else if (progressMetric === 'bodyfat') {
            const bfData = GymService.getBodyFatProgression(pid);
            const goalBF = player && player.goals && player.goals.targetBodyFat ? player.goals.targetBodyFat : null;
            if (bfData.length >= 2) {
                html += renderLineChart(bfData, 600, 200, 'Body Fat %', goalBF);
            } else {
                html += '<div class="gym-empty">Log at least 2 body fat entries<span class="gym-empty-dash"></span></div>';
            }
        } else if (progressMetric === 'bench_e1rm') {
            const data = GymService.getE1RMProgression(pid, 'bench_press');
            const liftGoal = player && player.goals && player.goals.liftGoals ? player.goals.liftGoals.find(g => g.exerciseId === 'bench_press') : null;
            if (data.length >= 2) {
                html += renderLineChart(data, 600, 200, 'Bench Press e1RM (' + unit + ')', liftGoal ? liftGoal.targetWeight : null);
            } else {
                html += '<div class="gym-empty">Log at least 2 bench sessions<span class="gym-empty-dash"></span></div>';
            }
        } else if (progressMetric === 'squat_e1rm') {
            const data = GymService.getE1RMProgression(pid, 'back_squat');
            const liftGoal = player && player.goals && player.goals.liftGoals ? player.goals.liftGoals.find(g => g.exerciseId === 'back_squat') : null;
            if (data.length >= 2) {
                html += renderLineChart(data, 600, 200, 'Back Squat e1RM (' + unit + ')', liftGoal ? liftGoal.targetWeight : null);
            } else {
                html += '<div class="gym-empty">Log at least 2 squat sessions<span class="gym-empty-dash"></span></div>';
            }
        } else if (progressMetric === 'weekly_volume') {
            const freqData = GymService.getWorkoutFrequency(pid);
            // Convert to volume per week
            const p = GymService.getPlayer(pid);
            if (p && p.workoutLog.length >= 2) {
                const sorted = p.workoutLog.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
                const weeks = {};
                sorted.forEach(w => {
                    const d = new Date(w.date);
                    const ws = new Date(d); ws.setDate(d.getDate() - d.getDay());
                    const key = ws.toISOString().slice(0, 10);
                    if (!weeks[key]) weeks[key] = 0;
                    weeks[key] += GymService.getWorkoutVolume(w);
                });
                const volData = Object.entries(weeks).map(([date, value]) => ({ date, value }));
                if (volData.length >= 2) {
                    html += renderLineChart(volData, 600, 200, 'Weekly Volume');
                } else {
                    html += '<div class="gym-empty">Need more data<span class="gym-empty-dash"></span></div>';
                }
            } else {
                html += '<div class="gym-empty">Need more workout data<span class="gym-empty-dash"></span></div>';
            }
        } else if (progressMetric === 'frequency') {
            const freqData = GymService.getWorkoutFrequency(pid);
            if (freqData.length >= 2) {
                html += renderLineChart(freqData, 600, 200, 'Workouts per Week');
            } else {
                html += '<div class="gym-empty">Need more workout data<span class="gym-empty-dash"></span></div>';
            }
        } else {
            // Specific exercise e1RM
            const data = GymService.getE1RMProgression(pid, progressMetric);
            const exDef = GymService.getExercise(progressMetric);
            const liftGoal = player && player.goals && player.goals.liftGoals ? player.goals.liftGoals.find(g => g.exerciseId === progressMetric) : null;
            if (data.length >= 2) {
                html += renderLineChart(data, 600, 200, (exDef ? exDef.name : '') + ' e1RM (' + unit + ')', liftGoal ? liftGoal.targetWeight : null);
            } else {
                html += '<div class="gym-empty">Log at least 2 sessions to see progression<span class="gym-empty-dash"></span></div>';
            }
        }
        html += '</div>';

        // PRs for exercise metrics
        if (progressMetric !== 'weight' && progressMetric !== 'bodyfat' && progressMetric !== 'weekly_volume' && progressMetric !== 'frequency') {
            const exId = progressMetric.replace('_e1rm', '');
            const mappedId = progressMetric === 'bench_e1rm' ? 'bench_press' : progressMetric === 'squat_e1rm' ? 'back_squat' : progressMetric;
            const prs = GymService.getPRs(pid, mappedId);
            if (prs.length > 0) {
                html += '<div class="gym-pr-section"><div class="gym-section-title">Personal Records</div><div class="gym-pr-cards">';
                prs.forEach((pr, i) => {
                    const e1rm = GymService.calcE1RM(pr.weight, pr.reps);
                    html += '<div class="gym-pr-card">' +
                        '<div class="gym-pr-card-rank">#' + (i + 1) + '</div>' +
                        '<div class="gym-pr-card-weight">' + pr.weight + unit + '</div>' +
                        '<div class="gym-pr-card-detail">' + pr.reps + ' reps -- e1RM: ' + e1rm + ' -- ' + fmtDate(pr.date) + '</div>' +
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
       TAB 4: ROUTINES + SETTINGS
    ══════════════════════════════════════════ */
    function renderRoutines() {
        const routines = GymService.getRoutines();
        const settings = GymService.getSettings();
        const player = GymService.getPlayer(activePlayer);
        const goals = player ? player.goals : { type: 'general' };

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
                    '<span class="gym-routine-exercise-detail">' + re.sets + 's @ ' + re.defaultWeight + (settings.weightUnit || 'lbs') + '</span>' +
                '</div>';
            });
            html += '</div>';
            if (isEditing) html += renderRoutineEditor(r);
            html += '</div>';
        });

        // Settings section
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

        // Goal Setup
        html += '<div class="gym-settings-section">' +
            '<div class="gym-section-title">Goal Setup</div>' +
            '<div class="gym-settings-row">' +
                '<span class="gym-settings-label">Goal Type</span>' +
                '<select class="gym-settings-input" data-goal="type" style="width:140px">' +
                    '<option value="general"' + (goals.type === 'general' ? ' selected' : '') + '>General Fitness</option>' +
                    '<option value="muscle"' + (goals.type === 'muscle' ? ' selected' : '') + '>Muscle Mass</option>' +
                    '<option value="strength"' + (goals.type === 'strength' ? ' selected' : '') + '>Strength</option>' +
                    '<option value="fatloss"' + (goals.type === 'fatloss' ? ' selected' : '') + '>Fat Loss</option>' +
                    '<option value="recomp"' + (goals.type === 'recomp' ? ' selected' : '') + '>Recomposition</option>' +
                '</select>' +
            '</div>' +
            '<div class="gym-settings-row">' +
                '<span class="gym-settings-label">Target Weight (' + (settings.weightUnit || 'lbs') + ')</span>' +
                '<input type="number" class="gym-settings-input" data-goal="targetWeight" value="' + (goals.targetWeight || '') + '" style="width:80px">' +
            '</div>' +
            '<div class="gym-settings-row">' +
                '<span class="gym-settings-label">Target Body Fat %</span>' +
                '<input type="number" class="gym-settings-input" data-goal="targetBodyFat" value="' + (goals.targetBodyFat || '') + '" style="width:80px">' +
            '</div>' +
            '<button class="gym-btn-sm" data-action="save-goals" style="margin-top:8px">Save Goals</button>' +
        '</div>';

        // Clear Data
        html += '<div class="gym-settings-section">' +
            '<button class="gym-btn-sm outline" data-action="clear-data" style="border-color:var(--gym-red);color:var(--gym-red)">Clear All Data</button>' +
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
        html += '</select></div></div>';
        return html;
    }

    /* ══════════════════════════════════════════
       TAB 5: BODY
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

        // Body Fat & Measurements
        html += '<div class="gym-body-section">' +
            '<div class="gym-body-section-title">Measurements</div>' +
            '<button class="gym-btn-sm outline" data-action="toggle-measurement-form" style="margin-bottom:10px">ADD MEASUREMENT</button>';
        if (showMeasurementForm) {
            html += '<div class="gym-measurement-form">' +
                '<div class="gym-form-row"><label class="gym-meas-label">Date</label><input type="date" class="gym-input" id="gym-meas-date" value="' + today() + '"></div>' +
                '<div class="gym-form-row"><label class="gym-meas-label">Body Fat %</label><input type="number" class="gym-input num" id="gym-meas-bf" step="0.1" placeholder="%"></div>' +
                '<div class="gym-form-row"><label class="gym-meas-label">Chest</label><input type="number" class="gym-input num" id="gym-meas-chest" step="0.1" placeholder="in"></div>' +
                '<div class="gym-form-row"><label class="gym-meas-label">Waist</label><input type="number" class="gym-input num" id="gym-meas-waist" step="0.1" placeholder="in"></div>' +
                '<div class="gym-form-row"><label class="gym-meas-label">Hip</label><input type="number" class="gym-input num" id="gym-meas-hip" step="0.1" placeholder="in"></div>' +
                '<div class="gym-form-row"><label class="gym-meas-label">Bicep</label><input type="number" class="gym-input num" id="gym-meas-bicep" step="0.1" placeholder="in"></div>' +
                '<div class="gym-form-row"><label class="gym-meas-label">Thigh</label><input type="number" class="gym-input num" id="gym-meas-thigh" step="0.1" placeholder="in"></div>' +
                '<button class="gym-btn-sm" data-action="save-measurement">Save Measurement</button>' +
            '</div>';
        }
        const measurements = GymService.getMeasurements(pid);
        if (measurements.length > 0) {
            html += '<table class="gym-weight-table"><thead><tr><th>Date</th><th>BF%</th><th>Chest</th><th>Waist</th><th>Bicep</th><th>Thigh</th></tr></thead><tbody>';
            measurements.slice(-5).reverse().forEach(m => {
                html += '<tr><td>' + fmtDate(m.date) + '</td><td>' + (m.bodyFat || '--') + '</td><td>' + (m.chest || '--') + '</td><td>' + (m.waist || '--') + '</td><td>' + (m.bicep || '--') + '</td><td>' + (m.thigh || '--') + '</td></tr>';
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
                    totalCal += item.calories || 0; totalP += item.protein || 0;
                    totalC += item.carbs || 0; totalF += item.fat || 0;
                });
            });
            html += '<div class="gym-diet-summary">' +
                '<div class="gym-diet-bar-card"><div class="gym-diet-bar-val">' + totalCal + '</div><div class="gym-diet-bar-label">Calories</div><div class="gym-diet-bar-fill"><div class="gym-diet-bar-fill-inner" style="width:' + Math.min(100, (totalCal / 2500) * 100) + '%;background:#e8a020"></div></div></div>' +
                '<div class="gym-diet-bar-card"><div class="gym-diet-bar-val">' + totalP + 'g</div><div class="gym-diet-bar-label">Protein</div><div class="gym-diet-bar-fill"><div class="gym-diet-bar-fill-inner" style="width:' + Math.min(100, (totalP / 180) * 100) + '%;background:#0984e3"></div></div></div>' +
                '<div class="gym-diet-bar-card"><div class="gym-diet-bar-val">' + totalC + 'g</div><div class="gym-diet-bar-label">Carbs</div><div class="gym-diet-bar-fill"><div class="gym-diet-bar-fill-inner" style="width:' + Math.min(100, (totalC / 300) * 100) + '%;background:#2ecc71"></div></div></div>' +
                '<div class="gym-diet-bar-card"><div class="gym-diet-bar-val">' + totalF + 'g</div><div class="gym-diet-bar-label">Fat</div><div class="gym-diet-bar-fill"><div class="gym-diet-bar-fill-inner" style="width:' + Math.min(100, (totalF / 80) * 100) + '%;background:#e74c3c"></div></div></div>' +
            '</div>';
            html += '<div class="gym-diet-items">';
            todayDiet.forEach(d => {
                (d.items || []).forEach(item => {
                    html += '<div class="gym-diet-item"><span class="gym-diet-item-name">' + esc(item.name) + '</span><span class="gym-diet-item-macros">' + item.calories + 'cal ' + item.protein + 'p ' + item.carbs + 'c ' + item.fat + 'f</span></div>';
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
            '<div id="gym-tab-content"></div>' +
        '</div>';
    }

    function renderActiveTab() {
        const el = container && container.querySelector('#gym-tab-content');
        if (!el) return;
        disposeCharacter();
        switch (activeTab) {
            case 'dashboard': el.innerHTML = '<div class="gym-tab-content">' + renderDashboard() + '</div>'; initDashboard(); break;
            case 'train':     el.innerHTML = renderTrain(); startTimerTick(); break;
            case 'progress':  el.innerHTML = '<div class="gym-tab-content">' + renderProgress() + '</div>'; break;
            case 'routines':  el.innerHTML = '<div class="gym-tab-content">' + renderRoutines() + '</div>'; break;
            case 'body':      el.innerHTML = '<div class="gym-tab-content">' + renderBody() + '</div>'; break;
        }
    }

    function initDashboard() {
        const wrap = container && container.querySelector('#gym-char-canvas');
        if (wrap) initCharacterCanvas(wrap);
    }

    function startTimerTick() {
        clearInterval(timerInterval);
        if (!workoutStartTime || !selectedRoutineId) return;
        timerInterval = setInterval(() => {
            const el = container && container.querySelector('#gym-timer');
            if (el) el.textContent = fmtTimer(Date.now() - workoutStartTime);
        }, 1000);
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
        container.querySelectorAll('.gym-player-avatar').forEach(el => {
            el.addEventListener('click', () => {
                activePlayer = el.dataset.player;
                container.innerHTML = render();
                bindEvents();
            });
        });
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
                if (action === 'toggle-goal-selector') { showGoalSelector = !showGoalSelector; renderActiveTab(); return; }
                if (action === 'start-workout') {
                    selectedRoutineId = actionEl.dataset.routine;
                    trainStep = 'workout'; activeTab = 'train';
                    container.querySelectorAll('.gym-tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tab === 'train'); });
                    logState = { sessionRPE: 5, energyLevel: 3, sleepHours: 7, sleepQuality: 3, stressLevel: 2, hydration: 'good', preWorkoutFed: 'yes', notes: '', sets: {}, exerciseNotes: {}, exerciseMMC: {} };
                    workoutStartTime = Date.now(); renderActiveTab(); return;
                }
                if (action === 'goto-body') {
                    activeTab = 'body';
                    container.querySelectorAll('.gym-tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tab === 'body'); });
                    renderActiveTab(); return;
                }
                if (action === 'back-to-choose') { trainStep = 'choose'; selectedRoutineId = null; workoutStartTime = null; clearInterval(timerInterval); renderActiveTab(); return; }
                if (action === 'save-workout') { saveWorkout(); return; }
                if (action === 'toggle-challenge-form') { showChallengeForm = !showChallengeForm; renderActiveTab(); return; }
                if (action === 'save-challenge') {
                    var cName = document.getElementById('gym-challenge-name');
                    var cValue = document.getElementById('gym-challenge-value');
                    var cUnit = document.getElementById('gym-challenge-unit');
                    var cDate = document.getElementById('gym-challenge-date');
                    if (!cName || !cName.value || !cValue || !cValue.value) return;
                    GymService.addChallenge(activePlayer, { name: cName.value, value: parseFloat(cValue.value) || 0, unit: cUnit ? cUnit.value : '', date: cDate ? cDate.value : today() });
                    showChallengeForm = false; showToast('Challenge added'); renderActiveTab(); return;
                }
                if (action === 'edit-routine') { editingRoutineId = editingRoutineId === actionEl.dataset.routine ? null : actionEl.dataset.routine; renderActiveTab(); return; }
                if (action === 'delete-routine') { if (confirm('Delete this routine?')) { GymService.deleteRoutine(actionEl.dataset.routine); renderActiveTab(); } return; }
                if (action === 'save-routine-edit') {
                    var rid = actionEl.dataset.routine;
                    var routine = GymService.getRoutine(rid);
                    if (!routine) return;
                    var nameInput = content.querySelector('[data-edit="name"]');
                    var descInput = content.querySelector('[data-edit="description"]');
                    if (nameInput) routine.name = nameInput.value;
                    if (descInput) routine.description = descInput.value;
                    GymService.updateRoutine(rid, routine);
                    editingRoutineId = null; renderActiveTab(); showToast('Routine saved'); return;
                }
                if (action === 'add-routine') {
                    var rName = prompt('Routine name:');
                    if (!rName) return;
                    var rDesc = prompt('Description:') || '';
                    var rId = rName.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now();
                    GymService.addRoutine({ id: rId, name: rName, description: rDesc, exercises: [] });
                    editingRoutineId = rId; renderActiveTab(); return;
                }
                if (action === 'save-goals') {
                    var goalType = content.querySelector('[data-goal="type"]');
                    var targetWeight = content.querySelector('[data-goal="targetWeight"]');
                    var targetBF = content.querySelector('[data-goal="targetBodyFat"]');
                    GymService.updateGoals(activePlayer, {
                        type: goalType ? goalType.value : 'general',
                        targetWeight: targetWeight && targetWeight.value ? parseFloat(targetWeight.value) : null,
                        targetBodyFat: targetBF && targetBF.value ? parseFloat(targetBF.value) : null
                    });
                    showToast('Goals saved'); renderActiveTab(); return;
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
                if (action === 'toggle-measurement-form') { showMeasurementForm = !showMeasurementForm; renderActiveTab(); return; }
                if (action === 'save-measurement') {
                    var mDate = document.getElementById('gym-meas-date');
                    var mBf = document.getElementById('gym-meas-bf');
                    var mChest = document.getElementById('gym-meas-chest');
                    var mWaist = document.getElementById('gym-meas-waist');
                    var mHip = document.getElementById('gym-meas-hip');
                    var mBicep = document.getElementById('gym-meas-bicep');
                    var mThigh = document.getElementById('gym-meas-thigh');
                    GymService.addMeasurement(activePlayer, {
                        date: mDate ? mDate.value : today(),
                        bodyFat: mBf && mBf.value ? parseFloat(mBf.value) : null,
                        chest: mChest && mChest.value ? parseFloat(mChest.value) : null,
                        waist: mWaist && mWaist.value ? parseFloat(mWaist.value) : null,
                        hip: mHip && mHip.value ? parseFloat(mHip.value) : null,
                        bicep: mBicep && mBicep.value ? parseFloat(mBicep.value) : null,
                        thigh: mThigh && mThigh.value ? parseFloat(mThigh.value) : null
                    });
                    showMeasurementForm = false; showToast('Measurement saved'); renderActiveTab(); return;
                }
                if (action === 'upload-photo') { var inp = document.getElementById('gym-photo-input'); if (inp) inp.click(); return; }
                if (action === 'save-diet') { saveDietItem(); return; }
            }

            /* Routine picker cards (Train tab) */
            var pickCard = e.target.closest('.gym-routine-pick-card[data-routine]');
            if (pickCard) {
                selectedRoutineId = pickCard.dataset.routine;
                trainStep = 'workout';
                logState = { sessionRPE: 5, energyLevel: 3, sleepHours: 7, sleepQuality: 3, stressLevel: 2, hydration: 'good', preWorkoutFed: 'yes', notes: '', sets: {}, exerciseNotes: {}, exerciseMMC: {} };
                workoutStartTime = Date.now(); renderActiveTab(); return;
            }

            /* Goal chip */
            var goalChip = e.target.closest('[data-goal-type]');
            if (goalChip) { GymService.updatePlayerGoal(activePlayer, goalChip.dataset.goalType); showGoalSelector = false; renderActiveTab(); return; }

            /* Metric pill */
            var metricPill = e.target.closest('[data-metric]');
            if (metricPill) { progressMetric = metricPill.dataset.metric; renderActiveTab(); return; }

            /* RPE button */
            var rpeBtn = e.target.closest('[data-rpe]');
            if (rpeBtn) {
                logState.sessionRPE = parseInt(rpeBtn.dataset.rpe);
                content.querySelectorAll('.gym-rpe-btn').forEach(function(b) { b.classList.toggle('active', parseInt(b.dataset.rpe) === logState.sessionRPE); });
                return;
            }

            /* Energy dot */
            var energyBtn = e.target.closest('[data-energy]');
            if (energyBtn) {
                logState.energyLevel = parseInt(energyBtn.dataset.energy);
                content.querySelectorAll('.gym-dot-btn[data-energy]').forEach(function(b) { b.classList.toggle('active', parseInt(b.dataset.energy) === logState.energyLevel); });
                return;
            }

            /* Stress dot */
            var stressBtn = e.target.closest('[data-stress]');
            if (stressBtn) {
                logState.stressLevel = parseInt(stressBtn.dataset.stress);
                content.querySelectorAll('.gym-dot-btn[data-stress]').forEach(function(b) { b.classList.toggle('active', parseInt(b.dataset.stress) === logState.stressLevel); });
                return;
            }

            /* Hydration button */
            var hydrationBtn = e.target.closest('[data-hydration]');
            if (hydrationBtn) {
                logState.hydration = hydrationBtn.dataset.hydration;
                content.querySelectorAll('.gym-hydration-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.hydration === logState.hydration); });
                return;
            }

            /* Mind-Muscle Connection dot */
            var mmcBtn = e.target.closest('[data-mmc-idx]');
            if (mmcBtn) {
                var idx = parseInt(mmcBtn.dataset.mmcIdx);
                logState.exerciseMMC[idx] = parseInt(mmcBtn.dataset.val);
                content.querySelectorAll('.gym-dot-btn[data-mmc-idx="' + idx + '"]').forEach(function(b) {
                    b.classList.toggle('active', parseInt(b.dataset.val) === logState.exerciseMMC[idx]);
                });
                return;
            }

            /* Set check button */
            var setCheck = e.target.closest('.gym-set-check');
            if (setCheck) {
                var key = setCheck.dataset.set;
                if (!logState.sets[key]) logState.sets[key] = {};
                logState.sets[key].completed = !logState.sets[key].completed;
                setCheck.classList.toggle('done', logState.sets[key].completed);
                return;
            }

            /* Add set button */
            var addSetBtn = e.target.closest('.gym-add-set-btn');
            if (addSetBtn) {
                var exIdx = parseInt(addSetBtn.dataset.exerciseIdx);
                var defSets = parseInt(addSetBtn.dataset.defaultSets);
                var countKey = '_count_' + exIdx;
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
        });

        /* ── Change delegation ── */
        content.addEventListener('change', function(e) {
            if (e.target.matches('.gym-set-rir-select')) {
                var key = e.target.dataset.set;
                if (!logState.sets[key]) logState.sets[key] = {};
                logState.sets[key].rir = parseInt(e.target.value);
            }
            if (e.target.matches('[data-field="sleepHours"]')) {
                logState.sleepHours = parseFloat(e.target.value) || 0;
            }
            if (e.target.matches('.gym-settings-input[data-setting]')) {
                var obj = {};
                if (e.target.tagName === 'SELECT') obj[e.target.dataset.setting] = e.target.value;
                else obj[e.target.dataset.setting] = parseInt(e.target.value) || 0;
                GymService.updateSettings(obj);
            }
            if (e.target.matches('[data-action="add-exercise-to-routine"]')) {
                if (!e.target.value) return;
                var rid = e.target.dataset.routine;
                var routine = GymService.getRoutine(rid);
                if (!routine) return;
                var settings = GymService.getSettings();
                routine.exercises.push({ exerciseId: e.target.value, sets: settings.defaultSets, defaultWeight: 0 });
                GymService.updateRoutine(rid, routine);
                renderActiveTab();
            }
            if (e.target.matches('#gym-photo-input')) {
                handlePhotoUpload();
            }
        });
    }

    /* ── Actions ── */
    function saveWorkout() {
        if (!selectedRoutineId) return;
        const routine = GymService.getRoutine(selectedRoutineId);
        if (!routine) return;

        const exercises = routine.exercises.map((re, reIdx) => {
            const sets = [];
            const numSets = logState.sets['_count_' + reIdx] || re.sets;
            for (let s = 0; s < numSets; s++) {
                const key = reIdx + '-' + s;
                const saved = logState.sets[key] || {};
                const weightInput = container.querySelector('.gym-set-weight[data-set="' + key + '"]');
                const repsInput = container.querySelector('.gym-set-reps[data-set="' + key + '"]');
                const rirSelect = container.querySelector('.gym-set-rir-select[data-set="' + key + '"]');
                sets.push({
                    setType: saved.setType || 'working',
                    weight: saved.weight !== undefined ? saved.weight : (weightInput ? parseFloat(weightInput.value) || 0 : re.defaultWeight || 0),
                    reps: saved.reps !== undefined ? saved.reps : (repsInput ? parseInt(repsInput.value) || 0 : 0),
                    rir: saved.rir !== undefined ? saved.rir : (rirSelect ? parseInt(rirSelect.value) : 2),
                    restSeconds: null,
                    tempo: null,
                    completed: saved.completed || false
                });
            }
            return {
                exerciseId: re.exerciseId,
                mmcQuality: logState.exerciseMMC[reIdx] || null,
                notes: logState.exerciseNotes[reIdx] || '',
                sets
            };
        });

        const workout = {
            date: today(),
            routineId: selectedRoutineId,
            startTime: workoutStartTime ? new Date(workoutStartTime).toISOString() : null,
            endTime: new Date().toISOString(),
            sessionRPE: logState.sessionRPE,
            energyLevel: logState.energyLevel,
            sleepHours: logState.sleepHours,
            sleepQuality: logState.sleepQuality,
            stressLevel: logState.stressLevel,
            hydration: logState.hydration,
            preWorkoutFed: logState.preWorkoutFed,
            notes: logState.notes,
            exercises
        };

        GymService.logWorkout(activePlayer, workout);
        logState = { sessionRPE: 5, energyLevel: 3, sleepHours: 7, sleepQuality: 3, stressLevel: 2, hydration: 'good', preWorkoutFed: 'yes', notes: '', sets: {}, exerciseNotes: {}, exerciseMMC: {} };
        workoutStartTime = null;
        selectedRoutineId = null;
        trainStep = 'choose';
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
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                GymService.addPhoto(activePlayer, { date, url: canvas.toDataURL('image/jpeg', 0.8) });
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
        const dietEntries = GymService.getDiet(activePlayer);
        const todayEntry = dietEntries.find(d => d.date === today());
        if (todayEntry) { todayEntry.items.push(item); GymService.save(); }
        else { GymService.logDiet(activePlayer, { date: today(), items: [item] }); }
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
            trainStep = 'choose';
            logState = { sessionRPE: 5, energyLevel: 3, sleepHours: 7, sleepQuality: 3, stressLevel: 2, hydration: 'good', preWorkoutFed: 'yes', notes: '', sets: {}, exerciseNotes: {}, exerciseMMC: {} };
            editingRoutineId = null;
            workoutStartTime = null;
            showChallengeForm = false;
            showGoalForm = false;
            showMeasurementForm = false;
            showLevelTooltip = false;
        }
    };
})();

BuildingRegistry.register('Gym', {
    open: (bodyEl, opts) => GymUI.open(bodyEl, opts),
    close: () => GymUI.close()
});
