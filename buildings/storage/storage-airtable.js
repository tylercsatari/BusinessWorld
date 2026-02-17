const StorageAirtable = (() => {
    const baseUrl = () => `https://api.airtable.com/v0/${CONFIG.airtable.baseId}`;
    const headers = () => ({
        'Authorization': `Bearer ${CONFIG.airtable.token}`,
        'Content-Type': 'application/json'
    });

    async function request(method, table, path = '', body = null) {
        const url = `${baseUrl()}/${encodeURIComponent(table)}${path}`;
        const opts = { method, headers: headers() };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(url, opts);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Airtable ${method} failed: ${res.status} - ${JSON.stringify(err)}`);
        }
        if (method === 'DELETE') return { deleted: true };
        return res.json();
    }

    async function listAll(table) {
        let all = [];
        let offset = null;
        do {
            const qs = offset ? `?pageSize=100&offset=${offset}` : '?pageSize=100';
            const data = await request('GET', table, qs);
            all = all.concat(data.records || []);
            offset = data.offset || null;
        } while (offset);
        return all;
    }

    return {
        async listBoxes() {
            const records = await listAll(CONFIG.airtable.boxesTable);
            return records.map(r => ({
                id: r.id,
                name: r.fields[CONFIG.airtable.boxesNameField] || '(unnamed)'
            }));
        },

        async listItems() {
            const records = await listAll(CONFIG.airtable.itemsTable);
            return records.map(r => ({
                id: r.id,
                name: r.fields[CONFIG.airtable.itemsNameField] || '(unnamed)',
                quantity: r.fields[CONFIG.airtable.itemsQuantityField] || 1,
                boxIds: r.fields[CONFIG.airtable.itemsLinkField] || []
            }));
        },

        async addItem(name, quantity, boxId) {
            const fields = {
                [CONFIG.airtable.itemsNameField]: name,
                [CONFIG.airtable.itemsQuantityField]: quantity,
                [CONFIG.airtable.itemsLinkField]: [boxId]
            };
            return request('POST', CONFIG.airtable.itemsTable, '', { fields });
        },

        async updateItemQty(itemId, newQty) {
            return request('PATCH', CONFIG.airtable.itemsTable, `/${itemId}`, {
                fields: { [CONFIG.airtable.itemsQuantityField]: newQty }
            });
        },

        async deleteItem(itemId) {
            return request('DELETE', CONFIG.airtable.itemsTable, `/${itemId}`);
        },

        async createBox(name) {
            return request('POST', CONFIG.airtable.boxesTable, '', {
                fields: { [CONFIG.airtable.boxesNameField]: name }
            });
        },

        async deleteBox(boxId) {
            return request('DELETE', CONFIG.airtable.boxesTable, `/${boxId}`);
        },

        async moveItem(itemId, newBoxId) {
            return request('PATCH', CONFIG.airtable.itemsTable, `/${itemId}`, {
                fields: { [CONFIG.airtable.itemsLinkField]: [newBoxId] }
            });
        }
    };
})();
