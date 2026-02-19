/**
 * Video Pipeline Service — shared CRUD for the video lifecycle.
 * Videos flow: Incubator (queued) -> Workshop (active) -> Pen (posted)
 * Backed by Notion — each video is a child page under videosDataPageId.
 * Metadata stored as a JSON code block (via NotionHelpers).
 */
const VideoService = (() => {
    let videos = [];
    let projects = []; // cached Dropbox project folder names
    let videosDataPageId = '';
    let _lastSync = 0;
    let _syncPromise = null; // dedup concurrent sync() calls

    async function loadConfig() {
        if (videosDataPageId) return;
        const cfg = await NotionHelpers.getConfig();
        if (cfg.notion && cfg.notion.videosDataPageId) videosDataPageId = cfg.notion.videosDataPageId;
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
            const cfg = await NotionHelpers.getConfig();
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
        async sync(force) {
            if (!force && videos.length > 0 && Date.now() - _lastSync < 60000) return videos;
            // Dedup concurrent sync() calls — return the same in-flight promise
            if (_syncPromise) return _syncPromise;
            _syncPromise = (async () => {
                await loadConfig();
                const pages = await NotionHelpers.fetchChildPages(videosDataPageId);
                const loaded = await Promise.all(pages.map(async page => {
                    try {
                        const meta = await NotionHelpers.loadPageMeta(page.id);
                        return pageToVideo(page, meta);
                    } catch (e) {
                        console.warn('VideoService: load content failed for', page.id, e);
                        return pageToVideo(page, {});
                    }
                }));
                videos = loaded;
                _lastSync = Date.now();
                return videos;
            })();
            try { return await _syncPromise; } finally { _syncPromise = null; }
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

            const result = await NotionHelpers.createChildPage(videosDataPageId, name, meta);
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
                await NotionHelpers.updatePageTitle(id, changes.name);
            }

            // Apply changes to local copy
            Object.assign(videos[idx], changes);
            // Bump sync timestamp so subsequent sync() returns this updated cache
            // instead of re-fetching from Notion (which could race with the write below)
            _lastSync = Date.now();

            // Save metadata code block
            await NotionHelpers.savePageMeta(id, videoToMeta(videos[idx]));
            return videos[idx];
        },

        async remove(id) {
            await NotionHelpers.archivePage(id);
            videos = videos.filter(v => v.id !== id);
        },

        // --- Status transitions ---
        async moveToIncubator(id) {
            return this.update(id, { status: 'incubator', assignedTo: '' });
        },

        // --- Bidirectional save+sync ---
        async saveWithIdeaSync(id, changes) {
            await this.update(id, changes);
            const video = this.getById(id);
            if (video && video.sourceIdeaId) {
                const idea = NotesService.getById(video.sourceIdeaId);
                if (idea) {
                    const syncChanges = {};
                    if (changes.name !== undefined) syncChanges.name = changes.name;
                    if (changes.hook !== undefined) syncChanges.hook = changes.hook;
                    if (changes.context !== undefined) syncChanges.context = changes.context;
                    if (changes.project !== undefined) syncChanges.project = changes.project;
                    if (Object.keys(syncChanges).length > 0) {
                        NotesService.update(idea.id, syncChanges).catch(() => {});
                    }
                }
            }
            return video;
        }
    };
})();
