/**
 * Video Pipeline Service — shared CRUD for the video lifecycle.
 * Videos flow: Incubator (queued) -> Workshop (active) -> Pen (posted)
 * Backed by R2 via /api/data/videos.
 */
const VideoService = (() => {
    let videos = [];
    let projects = []; // cached Dropbox project folder names
    let _lastSync = 0;
    let _syncPromise = null;

    async function fetchProjects() {
        if (projects.length > 0) return projects;
        try {
            const cfg = await HtmlUtils.getConfig();
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
        async sync(force) {
            if (!force && videos.length > 0 && Date.now() - _lastSync < 60000) return videos;
            if (_syncPromise) return _syncPromise;
            _syncPromise = (async () => {
                const res = await fetch('/api/data/videos');
                if (!res.ok) throw new Error(`Videos fetch failed: ${res.status}`);
                videos = await res.json();
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
            const res = await fetch('/api/data/videos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: videoData.name || 'Untitled Video',
                    project: videoData.project || '',
                    status: videoData.status || 'incubator',
                    hook: videoData.hook || '',
                    context: videoData.context || '',
                    linkedScriptId: videoData.linkedScriptId || '',
                    assignedTo: videoData.assignedTo || '',
                    postedDate: videoData.postedDate || '',
                    links: videoData.links || '',
                    sourceIdeaId: videoData.sourceIdeaId || '',
                    youtubeVideoId: videoData.youtubeVideoId || '',
                    analysisStatus: videoData.analysisStatus || ''
                })
            });
            if (!res.ok) throw new Error(`Create video failed: ${res.status}`);
            const video = await res.json();
            videos.push(video);
            return video;
        },

        async update(id, changes) {
            const idx = videos.findIndex(v => v.id === id);
            if (idx < 0) return null;

            const res = await fetch(`/api/data/videos/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(changes)
            });
            if (!res.ok) throw new Error(`Update video failed: ${res.status}`);
            const updated = await res.json();
            videos[idx] = updated;
            _lastSync = Date.now();
            return updated;
        },

        async remove(id) {
            const res = await fetch(`/api/data/videos/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error(`Delete video failed: ${res.status}`);
            videos = videos.filter(v => v.id !== id);
        },

        // --- Status transitions ---
        async moveToIncubator(id) {
            return this.update(id, { status: 'incubator', assignedTo: '' });
        },

        // --- Video Analysis ---
        async startVideoAnalysis(url) {
            const res = await fetch('/api/video/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url })
            });
            return res.json();
        },

        async getAnalysisStatus(ytId) {
            const res = await fetch(`/api/video/status/${ytId}`);
            if (!res.ok) return null;
            return res.json();
        },

        async discoverChannelShorts(channelUrl) {
            const res = await fetch('/api/video/discover-shorts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channelUrl })
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || `HTTP ${res.status}`);
            }
            return res.json();
        },

        async getVideoAnalysis(ytId) {
            const res = await fetch(`/api/video/analysis/${ytId}`);
            if (!res.ok) return null;
            return res.json();
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
