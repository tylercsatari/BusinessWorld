/**
 * Video Pipeline Service — shared CRUD for the video lifecycle.
 * Videos flow: Library (idea) -> Workshop pipeline (status 'pipeline') -> Pen (posted)
 * Legacy statuses 'incubator' and 'workshop' are treated as in-pipeline.
 * Backed by R2 via /api/data/videos.
 */
const VideoService = (() => {
    let videos = [];
    let projects = []; // cached Dropbox project folder names
    let _lastSync = 0;
    let _syncPromise = null;
    // In-flight create guard, keyed by sourceIdeaId. Prevents double-submit
    // (two clicks / two tabs) from racing two POSTs before the first response
    // updates the local cache.
    const _createInflight = new Map();

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

        // All videos in the deterministic pipeline (incl. legacy statuses)
        getPipeline() {
            return videos.filter(v => v.status === 'pipeline' || v.status === 'incubator' || v.status === 'workshop');
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
            const ideaId = videoData.sourceIdeaId || '';

            // Dedupe by sourceIdeaId: in-flight, then local cache.
            // Server is also authoritative (idempotent on sourceIdeaId).
            if (ideaId) {
                if (_createInflight.has(ideaId)) return _createInflight.get(ideaId);
                const cached = videos.find(v => v.sourceIdeaId === ideaId);
                if (cached) return cached;
            }

            const promise = (async () => {
                const res = await fetch('/api/data/videos', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: videoData.name || 'Untitled Video',
                        project: videoData.project || '',
                        status: videoData.status || 'pipeline',
                        hook: videoData.hook || '',
                        context: videoData.context || '',
                        script: videoData.script || '',
                        assignedTo: videoData.assignedTo || '',
                        assignedToList: Array.isArray(videoData.assignedToList) ? videoData.assignedToList : (videoData.assignedTo ? [videoData.assignedTo] : []),
                        postedDate: videoData.postedDate || '',
                        links: videoData.links || '',
                        sourceIdeaId: ideaId,
                        youtubeVideoId: videoData.youtubeVideoId || '',
                        analysisStatus: videoData.analysisStatus || '',
                        // --- Pipeline fields ---
                        stageState: videoData.stageState || {},          // { [stageId]: 'done' | 'na' }
                        branches: videoData.branches || {},              // decomp decisions { [flag]: true|false }
                        videoType: videoData.videoType || '',            // e.g. short / longform / series
                        deadline: videoData.deadline || '',
                        sponsorId: videoData.sponsorId || '',
                        projectIds: Array.isArray(videoData.projectIds) ? videoData.projectIds : [],
                        dependsOn: Array.isArray(videoData.dependsOn) ? videoData.dependsOn : [],
                        deps: Array.isArray(videoData.deps) ? videoData.deps : [],   // typed: [{kind:'video'|'component'|'order', id}]
                        dropboxPath: videoData.dropboxPath || '',      // shared project folder path for editor handoff
                        dropboxLink: videoData.dropboxLink || '',
                        voPath: videoData.voPath || '',                  // Dropbox path of the linked voiceover
                        voName: videoData.voName || '',
                        musicPath: videoData.musicPath || '',
                        musicName: videoData.musicName || '',
                        hookType: videoData.hookType || '',              // legacy single-hook fields (read as one instance)
                        hookVideoPath: videoData.hookVideoPath || '',
                        hookVideoName: videoData.hookVideoName || '',
                        hooks: Array.isArray(videoData.hooks) ? videoData.hooks : [],  // hook instances: [{id, type, label, videoPath, videoName}]
                        animAssets: Array.isArray(videoData.animAssets) ? videoData.animAssets : [],
                        animNoModels: !!videoData.animNoModels,
                        finalVideos: videoData.finalVideos || {},
                        requiredInventoryIds: Array.isArray(videoData.requiredInventoryIds) ? videoData.requiredInventoryIds : [],
                        producesInventoryIds: Array.isArray(videoData.producesInventoryIds) ? videoData.producesInventoryIds : []
                    })
                });
                if (!res.ok) throw new Error(`Create video failed: ${res.status}`);
                const video = await res.json();
                // Server may return an existing record (200) when deduped — avoid pushing a duplicate locally.
                const idx = videos.findIndex(v => v.id === video.id);
                if (idx >= 0) videos[idx] = video;
                else videos.push(video);
                return video;
            })();

            if (ideaId) _createInflight.set(ideaId, promise);
            try {
                return await promise;
            } finally {
                if (ideaId) _createInflight.delete(ideaId);
            }
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
        // Pull a posted video back into the pipeline
        async requeue(id) {
            return this.update(id, { status: 'pipeline' });
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
                    // Mirror EVERY shared field to the linked Library idea so the two
                    // records never diverge. `script` was historically missing here —
                    // that's why workshop/library scripts went out of sync.
                    const SHARED = ['name', 'hook', 'context', 'script', 'project'];
                    const syncChanges = {};
                    for (const f of SHARED) { if (changes[f] !== undefined) syncChanges[f] = changes[f]; }
                    if (Object.keys(syncChanges).length > 0) {
                        NotesService.update(idea.id, syncChanges).catch(() => {});
                    }
                }
            }
            return video;
        }
    };
})();
