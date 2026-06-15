/**
 * StorageR2 — the NEW storage data layer, backed by R2 via /api/data/* (fast).
 * Same interface as StorageAirtable so StorageService can swap between them
 * (new R2 data by default, "Old Version" reads the legacy Airtable data).
 */
const StorageR2 = (() => {
    async function api(method, coll, id, body) {
        const url = '/api/data/' + coll + (id ? '/' + encodeURIComponent(id) : '');
        const opts = { method, headers: { 'Content-Type': 'application/json' } };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(url, opts);
        if (!res.ok) throw new Error('Storage R2 ' + method + ' ' + coll + ' failed: ' + res.status);
        if (method === 'DELETE') return { deleted: true };
        return res.json();
    }
    return {
        async listBoxes() {
            const all = await api('GET', 'storageboxes');
            return (Array.isArray(all) ? all : []).map(b => ({ id: b.id, name: b.name || '(unnamed)' }));
        },
        async listItems() {
            const all = await api('GET', 'storageitems');
            return (Array.isArray(all) ? all : []).map(i => ({
                id: i.id, name: i.name || '(unnamed)',
                quantity: i.quantity || 1,
                boxIds: Array.isArray(i.boxIds) ? i.boxIds : []
            }));
        },
        async addItem(name, quantity, boxId) { return api('POST', 'storageitems', null, { name, quantity, boxIds: [boxId] }); },
        async updateItemQty(itemId, newQty) { return api('PATCH', 'storageitems', itemId, { quantity: newQty }); },
        async deleteItem(itemId) { return api('DELETE', 'storageitems', itemId); },
        async createBox(name) { return api('POST', 'storageboxes', null, { name }); },
        async deleteBox(boxId) { return api('DELETE', 'storageboxes', boxId); },
        async renameBox(boxId, newName) { return api('PATCH', 'storageboxes', boxId, { name: newName }); },
        async moveItem(itemId, newBoxId) { return api('PATCH', 'storageitems', itemId, { boxIds: [newBoxId] }); },
        // History is handled by storage-history.js (R2-backed) — no-ops here.
        async listHistory() { return []; },
        async addHistoryRecord() { return {}; }
    };
})();
