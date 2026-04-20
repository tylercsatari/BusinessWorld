/**
 * EmployeeService — single source of truth for the employee roster.
 *
 * Digital-only roster. The existing physical 3D employees in the world
 * (Robin/Jordan/Tennille + You) are represented as roster seeds so they
 * can be assigned anywhere the old WORKERS list was used.
 *
 * Roster persists through the layout save/load flow. Any module that
 * needs the set of assignable people should read from
 * EmployeeService.getNames() rather than hardcoding names.
 */
const EmployeeService = (() => {
    const SEEDS = [
        { id: 'you',      name: 'You',      role: 'Founder',      specialty: 'Direction',  colorHex: '#3498db', physical: true },
        { id: 'robin',    name: 'Robin',    role: 'Creator',      specialty: 'Ideas',      colorHex: '#e74c3c', physical: true },
        { id: 'jordan',   name: 'Jordan',   role: 'Editor',       specialty: 'Editing',    colorHex: '#9b59b6', physical: true },
        { id: 'tennille', name: 'Tennille', role: 'Producer',     specialty: 'Production', colorHex: '#ff69b4', physical: true },
    ];

    let roster = SEEDS.map(s => defaults(s));
    const listeners = new Set();

    function defaults(partial) {
        return {
            id: partial.id || genId(partial.name || 'employee'),
            name: partial.name || 'New Employee',
            role: partial.role || '',
            summary: partial.summary || '',
            strengths: partial.strengths || '',
            traits: partial.traits || '',
            specialty: partial.specialty || '',
            notes: partial.notes || '',
            stats: Object.assign({
                creativity: 3, reliability: 3, speed: 3,
                editing: 3, design: 3, leadership: 3
            }, partial.stats || {}),
            colorHex: partial.colorHex || colorForName(partial.name || partial.id || 'x'),
            physical: !!partial.physical,
            createdAt: partial.createdAt || Date.now(),
        };
    }

    function genId(seed) {
        const slug = String(seed).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'emp';
        let id = slug;
        let n = 2;
        while (roster.some(e => e.id === id)) { id = slug + '-' + n++; }
        return id;
    }

    function hashString(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) - h) + str.charCodeAt(i);
            h |= 0;
        }
        return h;
    }

    function colorForName(name) {
        const palette = [
            '#3498db','#e74c3c','#9b59b6','#ff69b4','#2ecc71','#f39c12',
            '#1abc9c','#e67e22','#34495e','#16a085','#d35400','#8e44ad',
            '#27ae60','#c0392b','#2980b9','#f1c40f'
        ];
        return palette[Math.abs(hashString(String(name))) % palette.length];
    }

    function notify() { listeners.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } }); }

    function hydrate(saved) {
        // saved: array of employee records. Merge with seeds, preserve seeds' physical flag.
        if (!Array.isArray(saved)) return;
        const merged = {};
        SEEDS.forEach(s => { merged[s.id] = defaults(s); });
        saved.forEach(rec => {
            if (!rec || !rec.name) return;
            const id = rec.id || genId(rec.name);
            const base = merged[id] || {};
            merged[id] = defaults(Object.assign({}, base, rec, { id, physical: base.physical || !!rec.physical }));
        });
        roster = Object.values(merged).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        notify();
    }

    function getAll() { return roster.slice(); }
    function getNames() { return roster.map(e => e.name); }
    function getById(id) { return roster.find(e => e.id === id) || null; }
    function getByName(name) { return roster.find(e => e.name === name) || null; }

    function add(partial) {
        const rec = defaults(partial || {});
        // make sure id is unique
        if (roster.some(e => e.id === rec.id)) rec.id = genId(rec.name);
        roster.push(rec);
        notify();
        return rec;
    }

    function update(id, patch) {
        const rec = roster.find(e => e.id === id);
        if (!rec) return null;
        Object.assign(rec, patch || {});
        if (patch && patch.stats) rec.stats = Object.assign({}, rec.stats, patch.stats);
        notify();
        return rec;
    }

    function remove(id) {
        const rec = roster.find(e => e.id === id);
        if (!rec || rec.physical) return false; // never remove physical seed employees
        roster = roster.filter(e => e.id !== id);
        notify();
        return true;
    }

    function serialize() {
        // Everything except derived fields. Persisted in layout.json.
        return roster.map(e => ({
            id: e.id, name: e.name, role: e.role, summary: e.summary,
            strengths: e.strengths, traits: e.traits, specialty: e.specialty,
            notes: e.notes, stats: e.stats, colorHex: e.colorHex,
            physical: e.physical, createdAt: e.createdAt,
        }));
    }

    function subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    function colorNumberForName(name) {
        const rec = getByName(name);
        const hex = (rec && rec.colorHex) || colorForName(name);
        return parseInt(hex.replace('#',''), 16);
    }

    return {
        hydrate, serialize,
        getAll, getNames, getById, getByName,
        add, update, remove,
        subscribe,
        colorForName, colorNumberForName,
    };
})();

if (typeof window !== 'undefined') window.EmployeeService = EmployeeService;
