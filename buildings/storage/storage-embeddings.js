/**
 * OpenAI Embeddings + Pinecone Vector Search.
 * Ported from StorageAI/src/vector/embedder.py, pinecone_index.py, search.py
 */
const StorageEmbeddings = (() => {

    // --- OpenAI Embeddings ---
    async function embedTexts(texts) {
        const res = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${CONFIG.openai.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: CONFIG.openai.embeddingModel,
                input: texts,
                dimensions: CONFIG.openai.embeddingDimensions
            })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Embedding failed: ${res.status} - ${JSON.stringify(err)}`);
        }
        const data = await res.json();
        // Sort by index to preserve order
        return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
    }

    async function embedText(text) {
        const vecs = await embedTexts([text]);
        return vecs[0];
    }

    // --- Pinecone REST API ---
    const pineconeHeaders = () => ({
        'Api-Key': CONFIG.pinecone.apiKey,
        'Content-Type': 'application/json'
    });

    async function pineconeUpsert(vectors) {
        const res = await fetch(`${CONFIG.pinecone.host}/vectors/upsert`, {
            method: 'POST',
            headers: pineconeHeaders(),
            body: JSON.stringify({
                vectors,
                namespace: CONFIG.pinecone.namespace
            })
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Pinecone upsert failed: ${res.status} - ${err}`);
        }
        return res.json();
    }

    async function pineconeDelete(ids) {
        const res = await fetch(`${CONFIG.pinecone.host}/vectors/delete`, {
            method: 'POST',
            headers: pineconeHeaders(),
            body: JSON.stringify({
                ids,
                namespace: CONFIG.pinecone.namespace
            })
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Pinecone delete failed: ${res.status} - ${err}`);
        }
        return res.json();
    }

    async function pineconeQuery(vector, topK = 5) {
        const res = await fetch(`${CONFIG.pinecone.host}/query`, {
            method: 'POST',
            headers: pineconeHeaders(),
            body: JSON.stringify({
                vector,
                topK,
                namespace: CONFIG.pinecone.namespace,
                includeMetadata: true
            })
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Pinecone query failed: ${res.status} - ${err}`);
        }
        const data = await res.json();
        return (data.matches || []).map(m => ({
            id: m.id,
            score: m.score,
            metadata: m.metadata || {}
        }));
    }

    // --- High-Level Semantic Search ---
    return {
        /**
         * Index an item in Pinecone.
         * @param {Object} item - {id, name, canonicalName, boxId}
         * @param {string} boxName - display name of box
         */
        async indexItem(item, boxName) {
            const canonical = item.canonicalName || StorageCanonicalize.normalizeToSingular(item.name);
            const vector = await embedText(canonical);
            await pineconeUpsert([{
                id: item.id,
                values: vector,
                metadata: {
                    name: item.name,
                    canonical_name: canonical,
                    box_id: item.boxIds ? item.boxIds[0] : '',
                    box_name: boxName || ''
                }
            }]);
        },

        /**
         * Remove an item from Pinecone.
         */
        async deleteItem(itemId) {
            try {
                await pineconeDelete([itemId]);
            } catch (e) {
                console.warn('Pinecone delete failed (non-fatal):', e.message);
            }
        },

        /**
         * Semantic search for an item.
         * Returns { bestMatch, bestScore, suggestions }
         * bestMatch = {id, name, canonicalName, boxId, boxName, score} or null
         * suggestions = [{id, name, score, boxName}, ...]
         */
        async findBestMatch(queryText, topK = 4) {
            const canonical = StorageCanonicalize.normalizeToSingular(queryText);
            const vector = await embedText(canonical);
            const matches = await pineconeQuery(vector, topK);

            if (matches.length === 0) {
                return { bestMatch: null, bestScore: 0, suggestions: [] };
            }

            const threshold = CONFIG.search.semanticMatchThreshold;
            const best = matches[0];

            if (best.score >= threshold) {
                return {
                    bestMatch: {
                        id: best.id,
                        name: best.metadata.name || '',
                        canonicalName: best.metadata.canonical_name || '',
                        boxId: best.metadata.box_id || '',
                        boxName: best.metadata.box_name || '',
                        score: best.score
                    },
                    bestScore: best.score,
                    suggestions: matches.slice(1).map(m => ({
                        id: m.id,
                        name: m.metadata.name || '',
                        score: m.score,
                        boxName: m.metadata.box_name || ''
                    }))
                };
            }

            return {
                bestMatch: null,
                bestScore: best.score,
                suggestions: matches.map(m => ({
                    id: m.id,
                    name: m.metadata.name || '',
                    score: m.score,
                    boxName: m.metadata.box_name || ''
                }))
            };
        },

        /**
         * Find all matches above threshold.
         */
        async findAllAboveThreshold(queryText, k = 10) {
            const canonical = StorageCanonicalize.normalizeToSingular(queryText);
            const vector = await embedText(canonical);
            const matches = await pineconeQuery(vector, k);
            const threshold = CONFIG.search.semanticMatchThreshold;
            return matches
                .filter(m => m.score >= threshold)
                .map(m => ({
                    id: m.id,
                    name: m.metadata.name || '',
                    canonicalName: m.metadata.canonical_name || '',
                    boxId: m.metadata.box_id || '',
                    boxName: m.metadata.box_name || '',
                    score: m.score
                }));
        },

        /**
         * Re-index all items from Airtable into Pinecone.
         * Used for manual sync.
         */
        async reindexAll(items, boxes) {
            const boxMap = {};
            for (const b of boxes) boxMap[b.id] = b.name;

            for (const item of items) {
                const boxName = item.boxIds && item.boxIds[0] ? (boxMap[item.boxIds[0]] || '') : '';
                await this.indexItem(item, boxName);
            }
        },

        // Expose low-level for GPT service usage
        embedText,
        embedTexts
    };
})();
