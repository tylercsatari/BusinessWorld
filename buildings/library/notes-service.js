/**
 * Notes Service — R2-backed ideas for the Library.
 * Each idea = a record in /api/data/ideas.
 * Ideas store hook/context as top-level fields (matching Videos).
 */
const NotesService = (() => {
    let notes = [];
    let _lastSync = 0;
    let _syncPromise = null;

    return {
        async sync(force) {
            if (!force && notes.length > 0 && Date.now() - _lastSync < 60000) return notes;
            if (_syncPromise) return _syncPromise;
            _syncPromise = (async () => {
                const res = await fetch('/api/data/ideas');
                if (!res.ok) throw new Error(`Ideas fetch failed: ${res.status}`);
                notes = await res.json();
                _lastSync = Date.now();
                return notes;
            })();
            try { return await _syncPromise; } finally { _syncPromise = null; }
        },

        getAll() { return notes; },
        getByType(type) { return notes.filter(n => n.type === type); },
        getByProject(project) { return notes.filter(n => n.project === project); },
        getById(id) { return notes.find(n => n.id === id); },

        async create(data) {
            const res = await fetch('/api/data/ideas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: data.name || 'Untitled',
                    hook: data.hook || '',
                    context: data.context || '',
                    script: data.script || '',
                    project: data.project || '',
                    type: data.type || 'idea',
                    lastEdited: new Date().toISOString()
                })
            });
            if (!res.ok) throw new Error(`Create idea failed: ${res.status}`);
            const note = await res.json();
            notes.push(note);
            return note;
        },

        async update(id, changes) {
            const note = notes.find(n => n.id === id);
            if (!note) return null;

            const fields = { ...changes, lastEdited: new Date().toISOString() };
            const res = await fetch(`/api/data/ideas/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fields)
            });
            if (!res.ok) throw new Error(`Update idea failed: ${res.status}`);
            const updated = await res.json();
            const idx = notes.findIndex(n => n.id === id);
            if (idx >= 0) notes[idx] = updated;
            return updated;
        },

        async remove(id) {
            const res = await fetch(`/api/data/ideas/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error(`Delete idea failed: ${res.status}`);
            notes = notes.filter(n => n.id !== id);
        }
    };
})();
