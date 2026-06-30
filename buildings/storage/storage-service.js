/**
 * Inventory business logic with semantic search integration.
 * Ported from StorageAI/src/services/inventory.py
 */
const StorageService = (() => {
    let boxes = [];
    let items = [];
    // Storage is R2-ONLY — the new version is the single source of truth. The legacy
    // Airtable path has been retired, so nothing ever reads or writes the old data.
    let DataLayer = StorageR2;
    let _source = 'r2';

    // --- Box resolution (fuzzy matching with number word ↔ digit normalization) ---
    function findBoxByName(name) {
        if (!name) return null;
        const inputCanonical = StorageCanonicalize.canonicalizeBoxName(name);
        if (!inputCanonical) return null;

        // 1. Canonical match (handles "shoes one" == "SHOES 1" == "shoes 1")
        let match = boxes.find(b =>
            StorageCanonicalize.canonicalizeBoxName(b.name) === inputCanonical
        );
        if (match) return match;

        // 2. No-space match (handles "SHOES1" == "SHOES 1")
        const inputNoSpace = inputCanonical.replace(/\s+/g, '');
        match = boxes.find(b =>
            StorageCanonicalize.canonicalizeBoxName(b.name).replace(/\s+/g, '') === inputNoSpace
        );
        if (match) return match;

        // 3. Exact uppercase match (raw, no normalization)
        const upper = name.trim().toUpperCase();
        match = boxes.find(b => b.name.toUpperCase() === upper);
        if (match) return match;

        // 4. StartsWith match on canonical form
        match = boxes.find(b =>
            StorageCanonicalize.canonicalizeBoxName(b.name).startsWith(inputCanonical)
        );
        if (match) return match;

        // 5. Single letter match
        if (inputCanonical.length === 1) {
            match = boxes.find(b => b.name.toUpperCase() === inputCanonical);
            if (match) return match;
        }

        return null;
    }

    function getBoxName(item) {
        if (!item.boxIds || item.boxIds.length === 0) return '(unassigned)';
        const box = boxes.find(b => b.id === item.boxIds[0]);
        return box ? box.name : '(unknown)';
    }

    function findItemById(itemId) {
        return items.find(i => i.id === itemId) || null;
    }

    // --- Resolve semantic match to concrete Airtable item ---
    function resolveSemanticToStoreItem(semanticMatch) {
        if (!semanticMatch) return null;
        // Direct ID match
        let item = findItemById(semanticMatch.id);
        if (item) return item;
        // Fallback: match by canonical name + box
        const canonical = (semanticMatch.canonicalName || semanticMatch.name || '').toLowerCase();
        item = items.find(i => {
            const iCanon = StorageCanonicalize.normalizeToSingular(i.name);
            return iCanon === canonical;
        });
        return item || null;
    }

    // Direct search over the live R2 items (canonical match + substring both ways).
    // This is the authoritative source so recall never depends on the vector index.
    function localSearchR2(name) {
        const q = (name || '').toLowerCase().trim();
        if (!q) return [];
        const canon = StorageCanonicalize.normalizeToSingular(name);
        return items.filter(i => {
            const iName = (i.name || '').toLowerCase();
            const iCanon = StorageCanonicalize.normalizeToSingular(i.name);
            return iCanon === canon || iName.includes(q) || q.includes(iName);
        });
    }

    return {
        getBoxes() { return boxes; },
        getItems() { return items; },
        getBoxName,
        findBoxByName,

        getItemsByBox(boxId) {
            return items.filter(i => i.boxIds && i.boxIds.includes(boxId));
        },

        getSource() { return _source; },

        // Retired: storage is R2-only now. Kept as a no-op (always R2) so any old
        // caller can't route reads/writes back to the legacy Airtable data.
        async setSource() {
            _source = 'r2';
            DataLayer = StorageR2;
            return this.sync();
        },

        async sync() {
            [boxes, items] = await Promise.all([
                DataLayer.listBoxes(),
                DataLayer.listItems()
            ]);
            // First time on the new R2 store: seed a starter box so it works right away.
            if (_source === 'r2' && boxes.length === 0 && items.length === 0) {
                try {
                    const res = await DataLayer.createBox('DEFAULT BOX');
                    const boxId = res.id;
                    for (const n of ['test item one', 'test item two', 'test item three']) {
                        const ir = await DataLayer.addItem(n, 1, boxId);
                        // index in the background — don't make the first load wait on embeddings
                        StorageEmbeddings.indexItem({ id: ir.id, name: n, quantity: 1, boxIds: [boxId] }, 'DEFAULT BOX').catch(() => {});
                    }
                    [boxes, items] = await Promise.all([DataLayer.listBoxes(), DataLayer.listItems()]);
                } catch (e) { console.warn('Storage: seeding default box failed (non-fatal):', e.message); }
            }
            return { boxes, items };
        },

        /**
         * Re-index all items in Pinecone (manual sync).
         */
        async reindexAll(logFn) {
            if (logFn) logFn('Re-indexing all items in vector database...');
            await StorageEmbeddings.reindexAll(items, boxes);
            if (logFn) logFn(`Indexed ${items.length} items in Pinecone.`);
        },

        /**
         * Pre-check whether adding this item would trigger a semantic merge.
         * Returns { wouldMerge, existingName, existingQty, existingBox, score, existingId }
         */
        async checkMerge(name) {
            const canonical = StorageCanonicalize.normalizeToSingular(name);
            try {
                const { bestMatch, bestScore } = await StorageEmbeddings.findBestMatch(canonical);
                if (bestMatch && bestScore >= CONFIG.search.semanticMatchThreshold) {
                    const existing = resolveSemanticToStoreItem(bestMatch);
                    if (existing) {
                        const existingBox = getBoxName(existing);
                        return {
                            wouldMerge: true,
                            existingName: bestMatch.name,
                            existingQty: existing.quantity,
                            existingBox: existingBox,
                            score: bestScore,
                            existingId: existing.id
                        };
                    }
                }
            } catch (e) {}
            return { wouldMerge: false };
        },

        /**
         * ADD item forcing creation (skips semantic merge check).
         */
        async addItemForce(name, qty, boxName) {
            const canonical = StorageCanonicalize.normalizeToSingular(name);
            let box = findBoxByName(boxName);
            if (!box) {
                const upper = (boxName || 'A').toUpperCase();
                const res = await DataLayer.createBox(upper);
                box = { id: res.id, name: upper };
                boxes.push(box);
            }
            const res = await DataLayer.addItem(canonical, qty, box.id);
            const newItem = { id: res.id, name: canonical, quantity: qty, boxIds: [box.id] };
            items.push(newItem);
            try { await StorageEmbeddings.indexItem(newItem, box.name); } catch(e) {}
            return { item: newItem, merged: false, boxName: box.name };
        },

        /**
         * ADD item with semantic merge detection.
         * If an item with similar name already exists (above threshold), increments its quantity.
         * Otherwise creates a new item.
         */
        async addItem(name, qty, boxName) {
            const canonical = StorageCanonicalize.normalizeToSingular(name);

            // Semantic search for existing item
            try {
                const { bestMatch, bestScore } = await StorageEmbeddings.findBestMatch(canonical);

                if (bestMatch && bestScore >= CONFIG.search.semanticMatchThreshold) {
                    // Found existing item — merge by incrementing quantity
                    const existing = resolveSemanticToStoreItem(bestMatch);
                    if (existing) {
                        const newQty = existing.quantity + qty;
                        await DataLayer.updateItemQty(existing.id, newQty);
                        existing.quantity = newQty;
                        const existingBox = getBoxName(existing);
                        // Update vector index metadata
                        await StorageEmbeddings.indexItem(existing, existingBox);
                        return {
                            item: existing,
                            merged: true,
                            mergedWith: bestMatch.name,
                            score: bestScore,
                            boxName: existingBox
                        };
                    }
                }
            } catch (e) {
                console.warn('Semantic search failed during add (continuing with create):', e.message);
            }

            // No semantic match — create new item
            let box = findBoxByName(boxName);
            if (!box) {
                const upper = (boxName || 'A').toUpperCase();
                const res = await DataLayer.createBox(upper);
                box = { id: res.id, name: upper };
                boxes.push(box);
            }

            const res = await DataLayer.addItem(canonical, qty, box.id);
            const newItem = { id: res.id, name: canonical, quantity: qty, boxIds: [box.id] };
            items.push(newItem);

            // Index in Pinecone
            try {
                await StorageEmbeddings.indexItem(newItem, box.name);
            } catch (e) {
                console.warn('Pinecone indexing failed (non-fatal):', e.message);
            }

            return { item: newItem, merged: false, boxName: box.name };
        },

        /**
         * REMOVE item using semantic search.
         * Returns { item, deleted, suggestions, error }
         */
        async removeItem(name, qty, resolvedItem = null) {
            let item, suggestions = [];

            if (resolvedItem) {
                item = resolveSemanticToStoreItem(resolvedItem) || resolvedItem;
            } else {
                try {
                    const result = await StorageEmbeddings.findBestMatch(name);
                    if (result.bestMatch && result.bestScore >= CONFIG.search.semanticMatchThreshold) {
                        item = resolveSemanticToStoreItem(result.bestMatch);
                        suggestions = result.suggestions;
                    } else {
                        // Below threshold — return suggestions
                        return { error: `No item matching "${name}" found.`, suggestions: result.suggestions };
                    }
                } catch (e) {
                    // Fallback to text search
                    const n = StorageCanonicalize.normalizeToSingular(name);
                    item = items.find(i => StorageCanonicalize.normalizeToSingular(i.name) === n);
                    if (!item) {
                        item = items.find(i => i.name.toLowerCase().includes(name.toLowerCase()));
                    }
                    if (!item) return { error: `No item matching "${name}" found.`, suggestions: [] };
                }
            }

            if (!item) return { error: `Could not resolve item "${name}".`, suggestions };

            const boxName = getBoxName(item);

            if (qty >= item.quantity || qty >= 9999) {
                // Delete entirely
                await DataLayer.deleteItem(item.id);
                try { await StorageEmbeddings.deleteItem(item.id); } catch (e) {}
                items = items.filter(i => i.id !== item.id);
                return { item: { ...item, quantity: 0 }, deleted: true, boxName, suggestions };
            }

            const newQty = item.quantity - qty;
            await DataLayer.updateItemQty(item.id, newQty);
            item.quantity = newQty;
            return { item, deleted: false, boxName, suggestions };
        },

        /**
         * FIND item using semantic search.
         * Returns { results, suggestions }
         */
        async findItem(name) {
            // Answers must reflect ONLY the new R2 data. The vector index is used purely
            // to rank/recall; every hit is then reconciled against the live R2 items, and
            // anything that isn't a current R2 record is dropped — so a question never
            // surfaces old/stale data that only exists in the legacy index.
            const byId = new Map();
            const add = (storeItem, score) => {
                if (!storeItem) return;
                const prev = byId.get(storeItem.id);
                if (prev && prev.score >= score) return;
                byId.set(storeItem.id, {
                    name: storeItem.name,
                    quantity: storeItem.quantity,
                    box: getBoxName(storeItem),
                    score
                });
            };
            // 1) Semantic recall — keep only matches that resolve to a real R2 item.
            try {
                const allMatches = await StorageEmbeddings.findAllAboveThreshold(name, 10);
                for (const m of allMatches) add(resolveSemanticToStoreItem(m), m.score);
            } catch (e) { /* vector search is optional; the R2 search below still answers */ }
            // 2) Always also search the R2 items directly, so recall doesn't depend on
            //    the index being in sync.
            for (const it of localSearchR2(name)) add(it, 1.0);

            const results = [...byId.values()].sort((a, b) => b.score - a.score);
            if (results.length) return { results, suggestions: [] };

            // Nothing in R2 — suggest near-name R2 items only (no legacy index data).
            const q = (name || '').toLowerCase().slice(0, 3);
            const suggestions = q
                ? items.map(i => i.name).filter(n => n.toLowerCase().includes(q)).slice(0, 5)
                : [];
            return { results: [], suggestions };
        },

        /**
         * MOVE item between boxes using semantic search.
         */
        async moveItem(itemName, toBoxName, resolvedItem = null) {
            let item, suggestions = [];

            if (resolvedItem) {
                item = resolveSemanticToStoreItem(resolvedItem) || resolvedItem;
            } else {
                try {
                    const result = await StorageEmbeddings.findBestMatch(itemName);
                    if (result.bestMatch && result.bestScore >= CONFIG.search.semanticMatchThreshold) {
                        item = resolveSemanticToStoreItem(result.bestMatch);
                        suggestions = result.suggestions;
                    } else {
                        return { error: `No item matching "${itemName}" found.`, suggestions: result.suggestions };
                    }
                } catch (e) {
                    const n = itemName.toLowerCase();
                    item = items.find(i => i.name.toLowerCase().includes(n));
                    if (!item) return { error: `No item matching "${itemName}" found.`, suggestions: [] };
                }
            }

            if (!item) return { error: `Could not resolve item "${itemName}".`, suggestions };

            const destBox = findBoxByName(toBoxName);
            if (!destBox) return { error: `Box "${toBoxName}" not found.` };

            if (item.boxIds && item.boxIds.includes(destBox.id)) {
                return { error: `"${item.name}" is already in box ${destBox.name}.` };
            }

            await DataLayer.moveItem(item.id, destBox.id);
            item.boxIds = [destBox.id];

            // Update vector index
            try { await StorageEmbeddings.indexItem(item, destBox.name); } catch (e) {}

            return { item, toBox: destBox.name, suggestions };
        },

        async setItemQuantity(itemId, newQty) {
            const item = items.find(i => i.id === itemId);
            if (!item) throw new Error('Item not found.');
            if (newQty <= 0) {
                await DataLayer.deleteItem(itemId);
                try { await StorageEmbeddings.deleteItem(itemId); } catch (e) {}
                items = items.filter(i => i.id !== itemId);
                return { deleted: true };
            }
            await DataLayer.updateItemQty(itemId, newQty);
            item.quantity = newQty;
            return item;
        },

        async addBox(name) {
            const upper = name.toUpperCase();
            if (findBoxByName(upper)) return { error: `Box "${upper}" already exists.` };
            const res = await DataLayer.createBox(upper);
            const box = { id: res.id, name: upper };
            boxes.push(box);
            return { box };
        },

        async renameBox(boxId, newName) {
            const box = boxes.find(b => b.id === boxId);
            if (!box) return { error: 'Box not found.' };
            const upper = newName.toUpperCase();
            await DataLayer.renameBox(boxId, upper);
            box.name = upper;
            return { box };
        },

        async removeBox(name) {
            const box = findBoxByName(name);
            if (!box) return { error: `Box "${name}" not found.` };
            const boxItems = items.filter(i => i.boxIds && i.boxIds.includes(box.id));
            if (boxItems.length > 0) return { error: `Box "${box.name}" is not empty (${boxItems.length} items). Clear it first.` };
            await DataLayer.deleteBox(box.id);
            boxes = boxes.filter(b => b.id !== box.id);
            return { box };
        },

        async clearBox(name) {
            const box = findBoxByName(name);
            if (!box) return { error: `Box "${name}" not found.` };
            const boxItems = items.filter(i => i.boxIds && i.boxIds.includes(box.id));
            for (const item of boxItems) {
                await DataLayer.deleteItem(item.id);
                try { await StorageEmbeddings.deleteItem(item.id); } catch (e) {}
            }
            items = items.filter(i => !(i.boxIds && i.boxIds.includes(box.id)));
            return { box, count: boxItems.length };
        },

        async moveAllItems(fromBoxName, toBoxName) {
            const fromBox = findBoxByName(fromBoxName);
            const toBox = findBoxByName(toBoxName);
            if (!fromBox) return { error: `Box "${fromBoxName}" not found.` };
            if (!toBox) return { error: `Box "${toBoxName}" not found.` };
            const boxItems = items.filter(i => i.boxIds && i.boxIds.includes(fromBox.id));
            for (const item of boxItems) {
                await DataLayer.moveItem(item.id, toBox.id);
                item.boxIds = [toBox.id];
                try { await StorageEmbeddings.indexItem(item, toBox.name); } catch (e) {}
            }
            return { count: boxItems.length, fromBox: fromBox.name, toBox: toBox.name };
        }
    };
})();
