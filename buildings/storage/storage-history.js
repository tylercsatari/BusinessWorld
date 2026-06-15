/**
 * StorageHistory — a structured, causality-aware change log for the storage room.
 *
 * Every add / remove / move / box op is recorded as a rich entry (item, qty,
 * fromBox → toBox, and a snapshot of what was removed) in the R2 `storagehistory`
 * collection. From that we can:
 *   - show a real timeline of what happened, when, and where things moved
 *   - answer "where was X before I removed it?" (the box is on the record)
 *   - RESTORE a removed/moved item by re-applying the inverse via StorageService
 *
 * Entry shape:
 *   { id, ts, action, item, qty, fromBox, toBox, snapshot, summary, restored }
 *   action ∈ add | remove | move | create_box | remove_box | clear_box |
 *            move_all | set_qty | restore
 */
const StorageHistory = (() => {
    const COLLECTION = 'storagehistory';
    let entries = [];      // cached, newest-last
    let loaded = false;

    async function load(force) {
        if (loaded && !force) return entries;
        try {
            const res = await fetch(`/api/data/${COLLECTION}`);
            if (res.ok) {
                const recs = await res.json();
                entries = (Array.isArray(recs) ? recs : []).sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
                loaded = true;
            }
        } catch (e) { console.warn('StorageHistory: load failed', e); }
        return entries;
    }

    // Fire-and-forget log of one change. Returns the created record (or null).
    async function log(entry) {
        const rec = { ts: new Date().toISOString(), restored: false, ...entry };
        entries.push(rec); // optimistic (real id filled in on response)
        try {
            const res = await fetch(`/api/data/${COLLECTION}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec)
            });
            if (res.ok) {
                const saved = await res.json();
                const idx = entries.indexOf(rec);
                if (idx >= 0) entries[idx] = saved;
                return saved;
            }
        } catch (e) { console.warn('StorageHistory: log failed', e); }
        return null;
    }

    function list() { return entries; }

    // The most recent box a (canonical) item name was seen in, per the log.
    function lastKnownBox(itemName) {
        const n = (itemName || '').toLowerCase();
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if ((e.item || '').toLowerCase().includes(n)) {
                return e.toBox || e.fromBox || (e.snapshot && e.snapshot[0] && e.snapshot[0].box) || null;
            }
        }
        return null;
    }

    // Search the log (for the assistant's "where was X" questions).
    function search(query, max = 8) {
        const q = (query || '').toLowerCase();
        return entries.slice().reverse()
            .filter(e => (e.item || '').toLowerCase().includes(q) || (e.summary || '').toLowerCase().includes(q) ||
                         (e.fromBox || '').toLowerCase().includes(q) || (e.toBox || '').toLowerCase().includes(q))
            .slice(0, max)
            .map(e => ({ ts: e.ts, action: e.action, item: e.item, qty: e.qty, fromBox: e.fromBox, toBox: e.toBox, summary: e.summary }));
    }

    // Re-apply the inverse of an entry. Returns { ok, message }.
    async function restore(id) {
        const e = entries.find(x => x.id === id);
        if (!e) return { ok: false, message: 'History entry not found.' };
        if (e.restored) return { ok: false, message: 'Already restored.' };
        try {
            let summary = '';
            switch (e.action) {
                case 'remove': {
                    // Put the removed quantity back in the box it came from
                    const qty = e.qty || 1;
                    await StorageService.addItemForce(e.item, qty, e.fromBox || 'A');
                    summary = `Restored ${qty}× ${e.item} to box ${e.fromBox || 'A'}`;
                    break;
                }
                case 'move': {
                    await StorageService.moveItem(e.item, e.fromBox);
                    summary = `Moved ${e.item} back to box ${e.fromBox}`;
                    break;
                }
                case 'add': {
                    await StorageService.removeItem(e.item, e.qty || 1);
                    summary = `Removed the ${e.qty || 1}× ${e.item} that was added to ${e.toBox}`;
                    break;
                }
                case 'clear_box': {
                    for (const it of (e.snapshot || [])) await StorageService.addItemForce(it.name, it.qty, it.box || e.fromBox);
                    summary = `Restored ${(e.snapshot || []).length} item(s) to box ${e.fromBox}`;
                    break;
                }
                case 'remove_box': {
                    await StorageService.addBox(e.fromBox);
                    summary = `Recreated box ${e.fromBox}`;
                    break;
                }
                case 'create_box': {
                    await StorageService.removeBox(e.toBox);
                    summary = `Removed box ${e.toBox}`;
                    break;
                }
                case 'move_all': {
                    await StorageService.moveAllItems(e.toBox, e.fromBox);
                    summary = `Moved everything back from ${e.toBox} to ${e.fromBox}`;
                    break;
                }
                default:
                    return { ok: false, message: `Can't restore a "${e.action}" entry.` };
            }
            // Mark restored + log the restore action
            e.restored = true;
            if (e.id) fetch(`/api/data/${COLLECTION}/${e.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restored: true }) }).catch(() => {});
            await log({ action: 'restore', item: e.item, summary, ofEntry: e.id });
            return { ok: true, message: summary };
        } catch (err) {
            return { ok: false, message: 'Restore failed: ' + err.message };
        }
    }

    return { load, log, list, restore, search, lastKnownBox, get loaded() { return loaded; } };
})();
