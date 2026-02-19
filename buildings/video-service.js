/**
 * Video Pipeline Service — shared CRUD for the video lifecycle.
 * Videos flow: Incubator (queued) -> Workshop (active) -> Pen (posted)
 * Backed by Notion — each video is a child page under videosDataPageId.
 * Metadata stored as a JSON code block (same pattern as NotesService).
 */
const VideoService = (() => {
    let videos = [];
    let projects = []; // cached Dropbox project folder names
    let videosDataPageId = '';

    async function loadConfig() {
        if (videosDataPageId) return;
        try {
            const res = await fetch('/api/config');
            const cfg = await res.json();
            if (cfg.notion && cfg.notion.videosDataPageId) videosDataPageId = cfg.notion.videosDataPageId;
        } catch (e) { console.warn('VideoService: config load failed', e); }
    }

    // --- Notion helpers ---
    async function fetchChildPages() {
        if (!videosDataPageId) return [];
        const res = await fetch(`/api/notion/blocks/${videosDataPageId}/children`);
        if (!res.ok) throw new Error(`Notion fetch failed: ${res.status}`);
        const data = await res.json();
        if (!data.results) return [];
        return data.results
            .filter(b => b.type === 'child_page' && !b.archived)
            .map(b => ({
                id: b.id,
                name: b.child_page.title,
                _loaded: false
            }));
    }

    async function loadPageContent(pageId) {
        const res = await fetch(`/api/notion/blocks/${pageId}/children`);
        if (!res.ok) return {};
        const data = await res.json();
        if (!data.results) return {};
        for (const block of data.results) {
            if (block.type === 'code') {
                const text = (block.code.rich_text || []).map(t => t.plain_text).join('');
                try { return JSON.parse(text); } catch (e) {}
            }
        }
        return {};
    }

    async function savePageContent(pageId, meta) {
        // Delete existing code blocks, then append new one
        const res = await fetch(`/api/notion/blocks/${pageId}/children`);
        if (res.ok) {
            const data = await res.json();
            for (const block of (data.results || [])) {
                if (block.type === 'code') {
                    await fetch(`/api/notion/blocks/${block.id}`, { method: 'DELETE' });
                }
            }
        }
        await fetch(`/api/notion/blocks/${pageId}/children`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                children: [{
                    object: 'block',
                    type: 'code',
                    code: {
                        language: 'json',
                        rich_text: [{ type: 'text', text: { content: JSON.stringify(meta) } }]
                    }
                }]
            })
        });
    }

    function pageToVideo(page, meta) {
        return {
            id: page.id,
            name: page.name || '',
            project: meta.project || '',
            status: meta.status || 'incubator',
            hook: meta.hook || '',
            context: meta.context || meta.notes || '', // backward compat: old notes → context
            linkedScriptId: meta.linkedScriptId || '',
            assignedTo: meta.assignedTo || '',
            postedDate: meta.postedDate || '',
            links: meta.links || '',
            sourceIdeaId: meta.sourceIdeaId || ''
        };
    }

    function videoToMeta(v) {
        return {
            project: v.project || '',
            status: v.status || 'incubator',
            hook: v.hook || '',
            context: v.context || '',
            linkedScriptId: v.linkedScriptId || '',
            assignedTo: v.assignedTo || '',
            postedDate: v.postedDate || '',
            links: v.links || '',
            sourceIdeaId: v.sourceIdeaId || ''
        };
    }

    // --- Dropbox project folders ---
    async function fetchProjects() {
        if (projects.length > 0) return projects;
        try {
            const cfgRes = await fetch('/api/config');
            const cfg = await cfgRes.json();
            const rootPath = (cfg.dropbox && cfg.dropbox.rootPath) || '';
            const res = await fetch('/api/dropbox/list_folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: rootPath || '' })
            });
            const data = await res.json();
            if (data.entries) {
                projects = data.entries
                    .filter(e => e['.tag'] === 'folder' && e.name !== 'Full Camera Roll')
                    .map(e => e.name)
                    .sort();
            }
        } catch (e) {
            console.warn('VideoService: project fetch failed', e);
        }
        return projects;
    }

    return {
        // --- Sync ---
        async sync() {
            await loadConfig();
            const pages = await fetchChildPages();
            const loaded = [];
            for (const page of pages) {
                try {
                    const meta = await loadPageContent(page.id);
                    loaded.push(pageToVideo(page, meta));
                } catch (e) {
                    console.warn('VideoService: load content failed for', page.id, e);
                    loaded.push(pageToVideo(page, {}));
                }
            }
            videos = loaded;
            return videos;
        },

        getAll() { return videos; },

        getByStatus(status) {
            return videos.filter(v => v.status === status);
        },

        getByProject(project) {
            return videos.filter(v => v.project === project);
        },

        getById(id) {
            return videos.find(v => v.id === id);
        },

        getByIdeaId(ideaId) {
            return videos.find(v => v.sourceIdeaId === ideaId);
        },

        async getProjects() {
            return fetchProjects();
        },

        getCachedProjects() {
            return projects;
        },

        // --- CRUD ---
        async create(videoData) {
            await loadConfig();
            if (!videosDataPageId) throw new Error('Videos data page not configured');
            const name = videoData.name || 'Untitled Video';
            const meta = videoToMeta({ status: 'incubator', ...videoData });

            const res = await fetch('/api/notion/pages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    parent: { page_id: videosDataPageId },
                    properties: { title: { title: [{ text: { content: name } }] } },
                    children: [{
                        object: 'block',
                        type: 'code',
                        code: {
                            language: 'json',
                            rich_text: [{ type: 'text', text: { content: JSON.stringify(meta) } }]
                        }
                    }]
                })
            });
            if (!res.ok) throw new Error(`Create video failed: ${res.status}`);
            const result = await res.json();
            const video = {
                id: result.id,
                name,
                ...meta
            };
            videos.push(video);
            return video;
        },

        async update(id, changes) {
            const idx = videos.findIndex(v => v.id === id);
            if (idx < 0) return null;

            // Update title if changed
            if (changes.name !== undefined && changes.name !== videos[idx].name) {
                await fetch(`/api/notion/pages/${id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        properties: { title: { title: [{ text: { content: changes.name } }] } }
                    })
                });
            }

            // Apply changes to local copy
            Object.assign(videos[idx], changes);

            // Save metadata code block
            await savePageContent(id, videoToMeta(videos[idx]));
            return videos[idx];
        },

        async remove(id) {
            await fetch(`/api/notion/pages/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ archived: true })
            });
            videos = videos.filter(v => v.id !== id);
        },

        // --- Status transitions ---
        async moveToWorkshop(id, assignedTo = '') {
            return this.update(id, { status: 'workshop', assignedTo });
        },

        async moveToPosted(id, links = '') {
            return this.update(id, {
                status: 'posted',
                postedDate: new Date().toISOString(),
                links
            });
        },

        async moveToIncubator(id) {
            return this.update(id, { status: 'incubator', assignedTo: '' });
        }
    };
})();
