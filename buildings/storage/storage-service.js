/**
 * Inventory business logic with semantic search integration.
 * Ported from StorageAI/src/services/inventory.py
 */
const StorageService = (() => {
    let boxes = [];
    let items = [];

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

    return {
        getBoxes() { return boxes; },
        getItems() { return items; },
        getBoxName,
        findBoxByName,

        getItemsByBox(boxId) {
            return items.filter(i => i.boxIds && i.boxIds.includes(boxId));
        },

        async sync() {
            [boxes, items] = await Promise.all([
                StorageAirtable.listBoxes(),
                StorageAirtable.listItems()
            ]);
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
                        await StorageAirtable.updateItemQty(existing.id, newQty);
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
                const res = await StorageAirtable.createBox(upper);
                box = { id: res.id, name: upper };
                boxes.push(box);
            }

            const res = await StorageAirtable.addItem(canonical, qty, box.id);
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
                await StorageAirtable.deleteItem(item.id);
                try { await StorageEmbeddings.deleteItem(item.id); } catch (e) {}
                items = items.filter(i => i.id !== item.id);
                return { item: { ...item, quantity: 0 }, deleted: true, boxName, suggestions };
            }

            const newQty = item.quantity - qty;
            await StorageAirtable.updateItemQty(item.id, newQty);
            item.quantity = newQty;
            return { item, deleted: false, boxName, suggestions };
        },

        /**
         * FIND item using semantic search.
         * Returns { results, suggestions }
         */
        async findItem(name) {
            try {
                // Get all matches above threshold
                const allMatches = await StorageEmbeddings.findAllAboveThreshold(name, 10);
                if (allMatches.length > 0) {
                    const results = allMatches.map(m => {
                        const storeItem = resolveSemanticToStoreItem(m);
                        return {
                            name: storeItem ? storeItem.name : m.name,
                            quantity: storeItem ? storeItem.quantity : '?',
                            box: m.boxName || (storeItem ? getBoxName(storeItem) : '?'),
                            score: m.score
                        };
                    });
                    return { results, suggestions: [] };
                }

                // Below threshold — show suggestions
                const { suggestions } = await StorageEmbeddings.findBestMatch(name);
                return { results: [], suggestions };
            } catch (e) {
                // Fallback to text search
                const n = name.toLowerCase();
                const textMatches = items.filter(i => i.name.toLowerCase().includes(n));
                return {
                    results: textMatches.map(m => ({
                        name: m.name,
                        quantity: m.quantity,
                        box: getBoxName(m),
                        score: 1.0
                    })),
                    suggestions: []
                };
            }
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

            await StorageAirtable.moveItem(item.id, destBox.id);
            item.boxIds = [destBox.id];

            // Update vector index
            try { await StorageEmbeddings.indexItem(item, destBox.name); } catch (e) {}

            return { item, toBox: destBox.name, suggestions };
        },

        async addBox(name) {
            const upper = name.toUpperCase();
            if (findBoxByName(upper)) return { error: `Box "${upper}" already exists.` };
            const res = await StorageAirtable.createBox(upper);
            const box = { id: res.id, name: upper };
            boxes.push(box);
            return { box };
        },

        async removeBox(name) {
            const box = findBoxByName(name);
            if (!box) return { error: `Box "${name}" not found.` };
            const boxItems = items.filter(i => i.boxIds && i.boxIds.includes(box.id));
            if (boxItems.length > 0) return { error: `Box "${box.name}" is not empty (${boxItems.length} items). Clear it first.` };
            await StorageAirtable.deleteBox(box.id);
            boxes = boxes.filter(b => b.id !== box.id);
            return { box };
        },

        async clearBox(name) {
            const box = findBoxByName(name);
            if (!box) return { error: `Box "${name}" not found.` };
            const boxItems = items.filter(i => i.boxIds && i.boxIds.includes(box.id));
            for (const item of boxItems) {
                await StorageAirtable.deleteItem(item.id);
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
                await StorageAirtable.moveItem(item.id, toBox.id);
                item.boxIds = [toBox.id];
                try { await StorageEmbeddings.indexItem(item, toBox.name); } catch (e) {}
            }
            return { count: boxItems.length, fromBox: fromBox.name, toBox: toBox.name };
        }
    };
})();
