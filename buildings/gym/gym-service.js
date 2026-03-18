/* ── Gym Service ── data layer, localStorage persistence ── */
const GymService = (() => {
    const STORAGE_KEY = 'gym-data';

    const PLAYER_COLORS = {
        tyler:   0x3498db,
        robin:   0xe74c3c,
        jordan:  0x9b59b6,
        tennille: 0xff69b4
    };

    const DEFAULT_EXERCISES = [
        { id: 'bench_press', name: 'Bench Press', category: 'push', defaultSets: 2, defaultReps: [4, 6], equipment: 'barbell' },
        { id: 'lat_pulldown', name: 'Lat Pulldown', category: 'pull', defaultSets: 3, defaultReps: [4, 6], equipment: 'cable' },
        { id: 'shoulder_press_seated', name: 'Shoulder Press (Seated)', category: 'push', defaultSets: 2, defaultReps: [4, 6], equipment: 'machine' },
        { id: 'seated_row', name: 'Seated Row', category: 'pull', defaultSets: 3, defaultReps: [4, 6], equipment: 'cable' },
        { id: 'pec_fly', name: 'Pec Fly', category: 'push', defaultSets: 2, defaultReps: [4, 6], equipment: 'machine' },
        { id: 'preacher_curls', name: 'Preacher Curls', category: 'pull', defaultSets: 2, defaultReps: [4, 6], equipment: 'barbell' },
        { id: 'tricep_extension', name: 'Tricep Extension', category: 'push', defaultSets: 2, defaultReps: [4, 6], equipment: 'cable' },
        { id: 'back_squat', name: 'Back Squat', category: 'legs', defaultSets: 2, defaultReps: [4, 6], equipment: 'barbell' },
        { id: 'rdl', name: 'RDL', category: 'legs', defaultSets: 2, defaultReps: [4, 6], equipment: 'barbell' },
        { id: 'leg_press', name: 'Leg Press', category: 'legs', defaultSets: 2, defaultReps: [4, 6], equipment: 'machine' },
        { id: 'calf_raise', name: 'Calf Raise', category: 'legs', defaultSets: 2, defaultReps: [4, 6], equipment: 'machine' },
        { id: 'core_machine', name: 'Core Machine', category: 'core', defaultSets: 2, defaultReps: [4, 6], equipment: 'machine' },
        { id: 'obliques', name: 'Obliques', category: 'core', defaultSets: 1, defaultReps: [4, 6], equipment: 'bodyweight' },
        { id: 'incline_bench', name: 'Incline Bench', category: 'push', defaultSets: 2, defaultReps: [4, 6], equipment: 'barbell' },
        { id: 'chin_up_weighted', name: 'Chin-Up (Weighted)', category: 'pull', defaultSets: 3, defaultReps: [4, 6], equipment: 'bodyweight' },
        { id: 'skull_crusher', name: 'Skull Crusher', category: 'push', defaultSets: 1, defaultReps: [4, 6], equipment: 'barbell' },
        { id: 'bicep_curls', name: 'Bicep Curls', category: 'pull', defaultSets: 1, defaultReps: [4, 6], equipment: 'dumbbell' },
        { id: 'leg_extension', name: 'Leg Extension', category: 'legs', defaultSets: 2, defaultReps: [4, 6], equipment: 'machine' },
        { id: 'front_squat', name: 'Front Squat', category: 'legs', defaultSets: 2, defaultReps: [4, 6], equipment: 'barbell' },
        { id: 'leg_curl', name: 'Leg Curl', category: 'legs', defaultSets: 2, defaultReps: [4, 6], equipment: 'machine' },
        { id: 'seated_calf_raise', name: 'Seated Calf Raise', category: 'legs', defaultSets: 2, defaultReps: [4, 6], equipment: 'machine' },
        { id: 'hanging_leg_raise', name: 'Hanging Leg Raise', category: 'core', defaultSets: 1, defaultReps: [4, 6], equipment: 'bodyweight' },
        { id: 'deadlift', name: 'Deadlift', category: 'legs', defaultSets: 2, defaultReps: [4, 6], equipment: 'barbell' }
    ];

    const DEFAULT_ROUTINES = [
        {
            id: 'upper1', name: 'Upper 1', description: 'Heavy Push/Pull',
            exercises: [
                { exerciseId: 'bench_press', sets: 2, defaultWeight: 185 },
                { exerciseId: 'lat_pulldown', sets: 3, defaultWeight: 160 },
                { exerciseId: 'shoulder_press_seated', sets: 2, defaultWeight: 110 },
                { exerciseId: 'seated_row', sets: 3, defaultWeight: 160 },
                { exerciseId: 'pec_fly', sets: 2, defaultWeight: 130 },
                { exerciseId: 'preacher_curls', sets: 2, defaultWeight: 55 },
                { exerciseId: 'tricep_extension', sets: 2, defaultWeight: 57 }
            ]
        },
        {
            id: 'lower1', name: 'Lower 1', description: 'Heavy Squat',
            exercises: [
                { exerciseId: 'back_squat', sets: 2, defaultWeight: 225 },
                { exerciseId: 'rdl', sets: 2, defaultWeight: 225 },
                { exerciseId: 'leg_press', sets: 2, defaultWeight: 180 },
                { exerciseId: 'calf_raise', sets: 2, defaultWeight: 400 },
                { exerciseId: 'core_machine', sets: 2, defaultWeight: 155 },
                { exerciseId: 'obliques', sets: 1, defaultWeight: 0 }
            ]
        },
        {
            id: 'upper2', name: 'Upper 2', description: 'Overhead/Pull',
            exercises: [
                { exerciseId: 'shoulder_press_seated', sets: 3, defaultWeight: 120 },
                { exerciseId: 'chin_up_weighted', sets: 3, defaultWeight: 220 },
                { exerciseId: 'incline_bench', sets: 2, defaultWeight: 155 },
                { exerciseId: 'seated_row', sets: 2, defaultWeight: 90 },
                { exerciseId: 'skull_crusher', sets: 1, defaultWeight: 80 },
                { exerciseId: 'bicep_curls', sets: 1, defaultWeight: 50 },
                { exerciseId: 'core_machine', sets: 2, defaultWeight: 150 }
            ]
        },
        {
            id: 'lower2', name: 'Lower 2', description: 'Deadlift',
            exercises: [
                { exerciseId: 'leg_extension', sets: 2, defaultWeight: 220 },
                { exerciseId: 'front_squat', sets: 2, defaultWeight: 155 },
                { exerciseId: 'leg_curl', sets: 2, defaultWeight: 160 },
                { exerciseId: 'seated_calf_raise', sets: 2, defaultWeight: 400 },
                { exerciseId: 'core_machine', sets: 2, defaultWeight: 125 },
                { exerciseId: 'hanging_leg_raise', sets: 1, defaultWeight: 0 }
            ]
        }
    ];

    function makePlayer(id, name) {
        return {
            id, name, color: PLAYER_COLORS[id] || 0x3498db,
            weight: [], photos: [], workoutLog: [],
            cardioLog: [], challenges: [], dietLog: [],
            measurements: [],
            goals: {
                type: 'general',
                targetWeight: null,
                targetBodyFat: null,
                liftGoals: []
            }
        };
    }

    function seedData() {
        return {
            players: [
                makePlayer('tyler', 'Tyler'),
                makePlayer('robin', 'Robin'),
                makePlayer('jordan', 'Jordan'),
                makePlayer('tennille', 'Tennille')
            ],
            routines: JSON.parse(JSON.stringify(DEFAULT_ROUTINES)),
            exercises: JSON.parse(JSON.stringify(DEFAULT_EXERCISES)),
            settings: {
                repRangeMin: 4, repRangeMax: 6, defaultSets: 2,
                weightUnit: 'lbs'
            }
        };
    }

    let data = null;

    function load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            data = raw ? JSON.parse(raw) : seedData();
        } catch (e) {
            console.warn('[Gym] Failed to load data, seeding fresh', e);
            data = seedData();
        }
        if (!data.players) data.players = seedData().players;
        if (!data.routines || data.routines.length === 0) data.routines = seedData().routines;
        if (!data.exercises || data.exercises.length === 0) data.exercises = seedData().exercises;
        if (!data.settings) data.settings = seedData().settings;
        // Ensure all 4 players exist
        const seed = seedData();
        seed.players.forEach(sp => {
            if (!data.players.find(p => p.id === sp.id)) {
                data.players.push(sp);
            }
        });
        // Ensure player fields
        data.players.forEach(p => {
            if (!p.color) p.color = PLAYER_COLORS[p.id] || 0x3498db;
            if (!p.goals) p.goals = { type: 'general', targetWeight: null, targetBodyFat: null, liftGoals: [] };
            if (!p.measurements) p.measurements = [];
            if (!p.workoutLog) p.workoutLog = [];
            if (!p.weight) p.weight = [];
            if (!p.photos) p.photos = [];
            if (!p.cardioLog) p.cardioLog = [];
            if (!p.challenges) p.challenges = [];
            if (!p.dietLog) p.dietLog = [];
        });
        if (!data.settings.weightUnit) data.settings.weightUnit = 'lbs';
        // Ensure deadlift exercise exists
        if (!data.exercises.find(e => e.id === 'deadlift')) {
            data.exercises.push({ id: 'deadlift', name: 'Deadlift', category: 'legs', defaultSets: 2, defaultReps: [4, 6], equipment: 'barbell' });
        }
        return data;
    }

    function save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            console.warn('[Gym] Failed to save data', e);
        }
    }

    function getData() {
        if (!data) load();
        return data;
    }

    function clearData() {
        data = seedData();
        save();
    }

    /* ── Players ── */
    function getPlayer(id) {
        return getData().players.find(p => p.id === id) || null;
    }
    function getPlayers() { return getData().players; }
    function addPlayer(player) { getData().players.push(player); save(); }
    function getPlayerColor(id) { return PLAYER_COLORS[id] || 0x3498db; }

    /* ── Goals ── */
    function updateGoals(playerId, goals) {
        const p = getPlayer(playerId);
        if (!p) return;
        Object.assign(p.goals, goals);
        save();
    }

    function updatePlayerGoal(playerId, goalType) {
        updateGoals(playerId, { type: goalType });
    }

    /* ── Measurements ── */
    function addMeasurement(playerId, m) {
        const p = getPlayer(playerId);
        if (!p) return;
        p.measurements.push(m);
        p.measurements.sort((a, b) => new Date(a.date) - new Date(b.date));
        save();
    }
    function getMeasurements(playerId) {
        const p = getPlayer(playerId);
        return p ? p.measurements.slice() : [];
    }

    /* ── Workouts ── */
    function logWorkout(playerId, workout) {
        const p = getPlayer(playerId);
        if (!p) return;
        p.workoutLog.push(workout);
        save();
    }
    function getWorkouts(playerId, limit) {
        const p = getPlayer(playerId);
        if (!p) return [];
        const sorted = p.workoutLog.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
        return limit ? sorted.slice(0, limit) : sorted;
    }

    /* ── Weight ── */
    function logWeight(playerId, date, value) {
        const p = getPlayer(playerId);
        if (!p) return;
        p.weight.push({ date, value: parseFloat(value) });
        p.weight.sort((a, b) => new Date(a.date) - new Date(b.date));
        save();
    }
    function getWeights(playerId) {
        const p = getPlayer(playerId);
        return p ? p.weight.slice() : [];
    }

    /* ── Cardio ── */
    function logCardio(playerId, entry) {
        const p = getPlayer(playerId);
        if (!p) return;
        p.cardioLog.push(entry);
        save();
    }
    function getCardio(playerId) {
        const p = getPlayer(playerId);
        return p ? p.cardioLog.slice() : [];
    }

    /* ── Diet ── */
    function logDiet(playerId, entry) {
        const p = getPlayer(playerId);
        if (!p) return;
        p.dietLog.push(entry);
        save();
    }
    function getDiet(playerId) {
        const p = getPlayer(playerId);
        return p ? p.dietLog.slice().sort((a, b) => new Date(b.date) - new Date(a.date)) : [];
    }

    /* ── Photos ── */
    function addPhoto(playerId, photo) {
        const p = getPlayer(playerId);
        if (!p) return;
        p.photos.push(photo);
        save();
    }
    function getPhotos(playerId) {
        const p = getPlayer(playerId);
        return p ? p.photos.slice() : [];
    }

    /* ── Challenges ── */
    function addChallenge(playerId, challenge) {
        const p = getPlayer(playerId);
        if (!p) return;
        p.challenges.push(challenge);
        save();
    }
    function getChallenges(playerId) {
        const p = getPlayer(playerId);
        return p ? p.challenges.slice() : [];
    }

    /* ── Routines ── */
    function getRoutines() { return getData().routines; }
    function getRoutine(id) { return getData().routines.find(r => r.id === id) || null; }
    function addRoutine(routine) { getData().routines.push(routine); save(); }
    function updateRoutine(id, updated) {
        const d = getData();
        const idx = d.routines.findIndex(r => r.id === id);
        if (idx >= 0) { d.routines[idx] = updated; save(); }
    }
    function deleteRoutine(id) {
        const d = getData();
        d.routines = d.routines.filter(r => r.id !== id);
        save();
    }

    /* ── Exercises ── */
    function getExercises() { return getData().exercises; }
    function getExercise(id) { return getData().exercises.find(e => e.id === id) || null; }
    function addExercise(exercise) { getData().exercises.push(exercise); save(); }

    /* ── Settings ── */
    function getSettings() { return getData().settings; }
    function updateSettings(s) { Object.assign(getData().settings, s); save(); }

    /* ── e1RM (Epley formula) ── */
    function calcE1RM(weight, reps) {
        if (reps <= 0 || weight <= 0) return 0;
        if (reps === 1) return weight;
        return Math.round(weight * (1 + reps / 30));
    }

    /* ── Get best e1RM for an exercise ── */
    function getExerciseE1RM(playerId, exerciseId) {
        const p = getPlayer(playerId);
        if (!p) return 0;
        let best = 0;
        p.workoutLog.forEach(w => {
            if (!w.exercises) return;
            const ex = w.exercises.find(e => e.exerciseId === exerciseId);
            if (!ex || !ex.sets) return;
            ex.sets.filter(s => s.completed).forEach(s => {
                const e1rm = calcE1RM(s.weight || 0, s.reps || 0);
                if (e1rm > best) best = e1rm;
            });
        });
        return best;
    }

    /* ── Progressive Overload ── */
    function getProgressionSuggestion(playerId, exerciseId) {
        const p = getPlayer(playerId);
        if (!p) return { suggest: false };
        const settings = getData().settings;
        const relevantLogs = p.workoutLog
            .filter(w => w.exercises && w.exercises.some(e => e.exerciseId === exerciseId))
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, 2);
        if (relevantLogs.length === 0) return { suggest: false };
        const lastLog = relevantLogs[0];
        const exercise = lastLog.exercises.find(e => e.exerciseId === exerciseId);
        if (!exercise || !exercise.sets || exercise.sets.length === 0) return { suggest: false };
        const completedSets = exercise.sets.filter(s => s.completed);
        if (completedSets.length === 0) return { suggest: false };
        const lastWeight = Math.max(...completedSets.map(s => s.weight || 0));
        const allHitMax = completedSets.every(s => s.reps >= settings.repRangeMax);
        if (allHitMax) return { suggest: true, weight: lastWeight + 5 };
        return { suggest: false, currentWeight: lastWeight };
    }

    /* ── Last session summary for an exercise ── */
    function getLastSessionSummary(playerId, exerciseId) {
        const p = getPlayer(playerId);
        if (!p) return null;
        const logs = p.workoutLog
            .filter(w => w.exercises && w.exercises.some(e => e.exerciseId === exerciseId))
            .sort((a, b) => new Date(b.date) - new Date(a.date));
        if (logs.length === 0) return null;
        const ex = logs[0].exercises.find(e => e.exerciseId === exerciseId);
        if (!ex || !ex.sets) return null;
        const completed = ex.sets.filter(s => s.completed);
        if (completed.length === 0) return null;
        return completed.map(s => (s.weight || 0) + ' x ' + (s.reps || 0)).join(', ');
    }

    function getLastWeight(playerId, exerciseId) {
        const p = getPlayer(playerId);
        if (!p) return null;
        const logs = p.workoutLog
            .filter(w => w.exercises && w.exercises.some(e => e.exerciseId === exerciseId))
            .sort((a, b) => new Date(b.date) - new Date(a.date));
        if (logs.length === 0) return null;
        const ex = logs[0].exercises.find(e => e.exerciseId === exerciseId);
        if (!ex || !ex.sets || ex.sets.length === 0) return null;
        const completed = ex.sets.filter(s => s.completed);
        return completed.length > 0 ? Math.max(...completed.map(s => s.weight || 0)) : null;
    }

    function getLastReps(playerId, exerciseId) {
        const p = getPlayer(playerId);
        if (!p) return null;
        const logs = p.workoutLog
            .filter(w => w.exercises && w.exercises.some(e => e.exerciseId === exerciseId))
            .sort((a, b) => new Date(b.date) - new Date(a.date));
        if (logs.length === 0) return null;
        const ex = logs[0].exercises.find(e => e.exerciseId === exerciseId);
        if (!ex || !ex.sets) return null;
        const completed = ex.sets.filter(s => s.completed);
        return completed.length > 0 ? completed[0].reps || 0 : null;
    }

    function getExerciseHistory(playerId, exerciseId, count) {
        count = count || 3;
        const p = getPlayer(playerId);
        if (!p) return [];
        return p.workoutLog
            .filter(w => w.exercises && w.exercises.some(e => e.exerciseId === exerciseId))
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, count)
            .map(w => {
                const ex = w.exercises.find(e => e.exerciseId === exerciseId);
                const maxW = ex.sets && ex.sets.length ? Math.max(...ex.sets.filter(s => s.completed).map(s => s.weight || 0)) : 0;
                return { date: w.date, weight: maxW };
            });
    }

    /* ── Next routine (rotation) ── */
    function getNextRoutine(playerId) {
        const order = ['upper1', 'lower1', 'upper2', 'lower2'];
        const p = getPlayer(playerId);
        if (!p || p.workoutLog.length === 0) return order[0];
        const sorted = p.workoutLog.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
        const lastIdx = order.indexOf(sorted[0].routineId);
        return order[(lastIdx + 1) % order.length];
    }

    /* ── Personal records ── */
    function getPRs(playerId, exerciseId) {
        const p = getPlayer(playerId);
        if (!p) return [];
        const prs = [];
        p.workoutLog.forEach(w => {
            if (!w.exercises) return;
            const ex = w.exercises.find(e => e.exerciseId === exerciseId);
            if (!ex || !ex.sets) return;
            ex.sets.filter(s => s.completed).forEach(s => {
                prs.push({ date: w.date, weight: s.weight || 0, reps: s.reps || 0 });
            });
        });
        prs.sort((a, b) => b.weight - a.weight || b.reps - a.reps);
        return prs.slice(0, 3);
    }

    function getBestLift(playerId, exerciseId) {
        const prs = getPRs(playerId, exerciseId);
        return prs.length > 0 ? prs[0] : null;
    }

    /* ── Stats ── */
    function getWorkoutsThisWeek(playerId) {
        const p = getPlayer(playerId);
        if (!p) return 0;
        const now = new Date();
        const dayOfWeek = now.getDay();
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - dayOfWeek);
        startOfWeek.setHours(0, 0, 0, 0);
        return p.workoutLog.filter(w => new Date(w.date) >= startOfWeek).length;
    }

    function getTotalWorkouts(playerId) {
        const p = getPlayer(playerId);
        return p ? p.workoutLog.length : 0;
    }

    function getWorkoutVolume(workout) {
        let vol = 0;
        if (!workout.exercises) return vol;
        workout.exercises.forEach(ex => {
            if (!ex.sets) return;
            ex.sets.filter(s => s.completed).forEach(s => {
                vol += (s.weight || 0) * (s.reps || 0);
            });
        });
        return vol;
    }

    /* ── Weekly volume (last 7 days) ── */
    function getWeeklyVolume(playerId) {
        const p = getPlayer(playerId);
        if (!p) return 0;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 7);
        let vol = 0;
        p.workoutLog.filter(w => new Date(w.date) >= cutoff).forEach(w => {
            vol += getWorkoutVolume(w);
        });
        return vol;
    }

    /* ── Exercise progression data for charts ── */
    function getExerciseProgression(playerId, exerciseId) {
        const p = getPlayer(playerId);
        if (!p) return [];
        const points = [];
        p.workoutLog
            .filter(w => w.exercises && w.exercises.some(e => e.exerciseId === exerciseId))
            .sort((a, b) => new Date(a.date) - new Date(b.date))
            .forEach(w => {
                const ex = w.exercises.find(e => e.exerciseId === exerciseId);
                if (!ex || !ex.sets) return;
                const completed = ex.sets.filter(s => s.completed);
                if (completed.length === 0) return;
                const maxW = Math.max(...completed.map(s => s.weight || 0));
                points.push({ date: w.date, value: maxW });
            });
        return points;
    }

    /* ── e1RM progression for charts ── */
    function getE1RMProgression(playerId, exerciseId) {
        const p = getPlayer(playerId);
        if (!p) return [];
        const points = [];
        p.workoutLog
            .filter(w => w.exercises && w.exercises.some(e => e.exerciseId === exerciseId))
            .sort((a, b) => new Date(a.date) - new Date(b.date))
            .forEach(w => {
                const ex = w.exercises.find(e => e.exerciseId === exerciseId);
                if (!ex || !ex.sets) return;
                const completed = ex.sets.filter(s => s.completed);
                if (completed.length === 0) return;
                let best = 0;
                completed.forEach(s => {
                    const e1rm = calcE1RM(s.weight || 0, s.reps || 0);
                    if (e1rm > best) best = e1rm;
                });
                if (best > 0) points.push({ date: w.date, value: best });
            });
        return points;
    }

    /* ── Simple level system: every 5 workouts = 1 level ── */
    function getPlayerLevel(playerId) {
        const p = getPlayer(playerId);
        if (!p) return { level: 1, workoutsInLevel: 0, workoutsToNext: 5, totalWorkouts: 0 };
        const total = p.workoutLog.length;
        const level = Math.floor(total / 5) + 1;
        const workoutsInLevel = total % 5;
        const workoutsToNext = 5 - workoutsInLevel;
        return { level, workoutsInLevel, workoutsToNext, totalWorkouts: total };
    }

    /* ── Body fat progression ── */
    function getBodyFatProgression(playerId) {
        const m = getMeasurements(playerId);
        return m.filter(entry => entry.bodyFat != null).map(entry => ({
            date: entry.date,
            value: entry.bodyFat
        }));
    }

    /* ── Workout frequency (workouts per week over time) ── */
    function getWorkoutFrequency(playerId) {
        const p = getPlayer(playerId);
        if (!p || p.workoutLog.length === 0) return [];
        const sorted = p.workoutLog.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
        const weeks = {};
        sorted.forEach(w => {
            const d = new Date(w.date);
            const weekStart = new Date(d);
            weekStart.setDate(d.getDate() - d.getDay());
            const key = weekStart.toISOString().slice(0, 10);
            weeks[key] = (weeks[key] || 0) + 1;
        });
        return Object.entries(weeks).map(([date, value]) => ({ date, value }));
    }

    return {
        load, save, getData, clearData,
        getPlayer, getPlayers, addPlayer, getPlayerColor,
        updateGoals, updatePlayerGoal,
        addMeasurement, getMeasurements,
        logWorkout, getWorkouts,
        logWeight, getWeights,
        logCardio, getCardio,
        logDiet, getDiet,
        addPhoto, getPhotos,
        addChallenge, getChallenges,
        getRoutines, getRoutine, addRoutine, updateRoutine, deleteRoutine,
        getExercises, getExercise, addExercise,
        getSettings, updateSettings,
        calcE1RM, getExerciseE1RM,
        getProgressionSuggestion, getLastWeight, getLastReps, getLastSessionSummary,
        getExerciseHistory, getNextRoutine, getPRs, getBestLift,
        getWorkoutsThisWeek, getTotalWorkouts, getWorkoutVolume, getWeeklyVolume,
        getExerciseProgression, getE1RMProgression,
        getPlayerLevel, getBodyFatProgression, getWorkoutFrequency,
        PLAYER_COLORS
    };
})();
