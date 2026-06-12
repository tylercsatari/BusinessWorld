/**
 * PipelineService — client-side stores for the pipeline's linked objects.
 * Backed by the generic /api/data/* R2 collections:
 *   projects   — build projects (e.g. "Doc Ock Suit"); span multiple videos
 *   components — parts of a project (e.g. "The Claw"); have their own build status
 *   orders     — things to buy: needed → ordered → received
 *   inventory  — the Component Library: props / footage / sets that exist or are being made
 *   sponsors   — shared with the Library's Sponsors tab (same records, no duplicates)
 *
 * Record shapes:
 *   project:   { id, name, description, status: 'active'|'done'|'archived', deadline, notes }
 *   component: { id, projectId, name, status: 'design'|'cad'|'manufacturing'|'assembly'|'done', notes }
 *   order:     { id, name, status: 'needed'|'ordered'|'received', link, cost, qty,
 *                videoId, projectId, componentId, notes }
 *   inventory: { id, name, type: 'prop'|'footage'|'set'|'material'|'other',
 *                status: 'planned'|'building'|'ready', source: 'built'|'ordered'|'owned'|'filmed',
 *                projectId, producedByVideoId, location, notes }
 */
const PipelineService = (() => {

    function makeStore(collection) {
        let records = [];
        let lastSync = 0;
        let syncPromise = null;

        return {
            async sync(force) {
                if (!force && lastSync > 0 && Date.now() - lastSync < 60000) return records;
                if (syncPromise) return syncPromise;
                syncPromise = (async () => {
                    const res = await fetch(`/api/data/${collection}`);
                    if (!res.ok) throw new Error(`${collection} fetch failed: ${res.status}`);
                    records = await res.json();
                    lastSync = Date.now();
                    return records;
                })();
                try { return await syncPromise; } finally { syncPromise = null; }
            },
            getAll() { return records; },
            getById(id) { return records.find(r => r.id === id) || null; },
            async create(data) {
                const res = await fetch(`/api/data/${collection}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                if (!res.ok) throw new Error(`Create ${collection} failed: ${res.status}`);
                const rec = await res.json();
                const idx = records.findIndex(r => r.id === rec.id);
                if (idx >= 0) records[idx] = rec; else records.push(rec);
                return rec;
            },
            async update(id, changes) {
                const res = await fetch(`/api/data/${collection}/${id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(changes)
                });
                if (!res.ok) throw new Error(`Update ${collection} failed: ${res.status}`);
                const rec = await res.json();
                const idx = records.findIndex(r => r.id === id);
                if (idx >= 0) records[idx] = rec; else records.push(rec);
                return rec;
            },
            async remove(id) {
                const res = await fetch(`/api/data/${collection}/${id}`, { method: 'DELETE' });
                if (!res.ok) throw new Error(`Delete ${collection} failed: ${res.status}`);
                records = records.filter(r => r.id !== id);
            }
        };
    }

    const projects = makeStore('projects');
    const components = makeStore('components');
    const orders = makeStore('orders');
    const inventory = makeStore('inventory');
    const sponsors = makeStore('sponsors');

    return {
        projects, components, orders, inventory, sponsors,

        // Sync everything the pipeline UI needs (individual failures tolerated)
        async syncAll(force) {
            await Promise.all([
                projects.sync(force).catch(e => console.warn('PipelineService: projects sync failed', e)),
                components.sync(force).catch(e => console.warn('PipelineService: components sync failed', e)),
                orders.sync(force).catch(e => console.warn('PipelineService: orders sync failed', e)),
                inventory.sync(force).catch(e => console.warn('PipelineService: inventory sync failed', e)),
                sponsors.sync(force).catch(e => console.warn('PipelineService: sponsors sync failed', e))
            ]);
        },

        componentsForProject(projectId) {
            return components.getAll().filter(c => c.projectId === projectId);
        },
        ordersForVideo(videoId) {
            return orders.getAll().filter(o => o.videoId === videoId);
        },
        ordersForProject(projectId) {
            return orders.getAll().filter(o => o.projectId === projectId);
        },
        inventoryForProject(projectId) {
            return inventory.getAll().filter(i => i.projectId === projectId);
        },

        // When a video is posted, everything it produces becomes ready inventory.
        // Deterministic handoff: post video → props become reusable.
        async markProducedInventoryReady(video) {
            const ids = video.producesInventoryIds || [];
            await Promise.all(ids.map(async id => {
                const item = inventory.getById(id);
                if (item && item.status !== 'ready') {
                    await inventory.update(id, { status: 'ready' }).catch(() => {});
                }
            }));
        }
    };
})();
