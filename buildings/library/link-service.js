/**
 * LinkService — Centralized bidirectional script linking.
 * One call links/unlinks both sides (script meta ↔ idea/video).
 * All buildings use this instead of duplicating linking logic.
 *
 * Uses ScriptService for script content (no UI dependency).
 */
const LinkService = (() => {
    const listeners = [];

    function notify() {
        for (const fn of listeners) { try { fn(); } catch (e) {} }
    }

    // --- Internal helpers ---

    async function readScriptMeta(scriptId) {
        const data = await ScriptService.loadContent(scriptId);
        return { meta: data.meta, text: data.text };
    }

    async function writeScriptMeta(scriptId, text, meta) {
        await ScriptService.saveContent(scriptId, text, meta);
    }

    function updateScriptsCache(scriptId, project) {
        const s = ScriptService.getAll().find(s => s.id === scriptId);
        if (s) s.project = project;
    }

    // --- Public API ---

    return {
        /**
         * Bidirectional link: script ↔ idea.
         * Sets idea.linkedScriptId and script meta.linkedIdeaId.
         * Clears any previous linkedVideoId on the script.
         */
        async linkScriptToIdea(scriptId, ideaId) {
            const idea = NotesService.getById(ideaId);
            const project = (idea && idea.project) || '';

            // Update idea side
            await NotesService.update(ideaId, { linkedScriptId: scriptId });

            // Update script side
            const { meta, text } = await readScriptMeta(scriptId);
            meta.linkedIdeaId = ideaId;
            meta.linkedVideoId = '';
            meta.project = project || meta.project || '';
            await writeScriptMeta(scriptId, text, meta);

            updateScriptsCache(scriptId, meta.project);
            notify();
        },

        /**
         * Bidirectional link: script ↔ video.
         * Sets video.linkedScriptId and script meta.linkedVideoId.
         * Clears any previous linkedIdeaId on the script.
         */
        async linkScriptToVideo(scriptId, videoId) {
            const video = VideoService.getById(videoId);
            const project = (video && video.project) || '';

            // Update video side
            await VideoService.update(videoId, { linkedScriptId: scriptId });

            // Update script side
            const { meta, text } = await readScriptMeta(scriptId);
            meta.linkedVideoId = videoId;
            meta.linkedIdeaId = '';
            meta.project = project || meta.project || '';
            await writeScriptMeta(scriptId, text, meta);

            updateScriptsCache(scriptId, meta.project);
            notify();
        },

        /**
         * Unlink a script from whatever it's connected to.
         * Reads the script's meta, clears both sides.
         */
        async unlinkScript(scriptId) {
            const { meta, text } = await readScriptMeta(scriptId);

            // Clear the other side
            if (meta.linkedIdeaId) {
                NotesService.update(meta.linkedIdeaId, { linkedScriptId: '' }).catch(() => {});
            }
            if (meta.linkedVideoId) {
                VideoService.update(meta.linkedVideoId, { linkedScriptId: '' }).catch(() => {});
            }

            // Clear script side (preserve project)
            meta.linkedIdeaId = '';
            meta.linkedVideoId = '';
            await writeScriptMeta(scriptId, text, meta);

            notify();
        },

        /**
         * Unlink from idea side — finds the linked script and clears both sides.
         */
        async unlinkFromIdea(ideaId) {
            const idea = NotesService.getById(ideaId);
            const scriptId = idea && idea.linkedScriptId;

            // Clear idea side
            await NotesService.update(ideaId, { linkedScriptId: '' });

            // Clear script side (preserve project)
            if (scriptId) {
                const { meta, text } = await readScriptMeta(scriptId);
                meta.linkedIdeaId = '';
                meta.linkedVideoId = '';
                await writeScriptMeta(scriptId, text, meta);
            }
            notify();
        },

        /**
         * Unlink from video side — finds the linked script and clears both sides.
         */
        async unlinkFromVideo(videoId) {
            const video = VideoService.getById(videoId);
            const scriptId = video && video.linkedScriptId;

            // Clear video side
            await VideoService.update(videoId, { linkedScriptId: '' });

            // Clear script side (preserve project)
            if (scriptId) {
                const { meta, text } = await readScriptMeta(scriptId);
                meta.linkedIdeaId = '';
                meta.linkedVideoId = '';
                await writeScriptMeta(scriptId, text, meta);
            }
            notify();
        },

        /**
         * Get set of all linked script IDs (for "available" filtering in pickers).
         * Optionally exclude one ID (the current item's own linked script).
         */
        getLinkedScriptIds(excludeId) {
            const fromVideos = VideoService.getAll().filter(v => v.linkedScriptId).map(v => v.linkedScriptId);
            const fromIdeas = NotesService.getAll().filter(n => n.linkedScriptId).map(n => n.linkedScriptId);
            const set = new Set([...fromVideos, ...fromIdeas]);
            if (excludeId) set.delete(excludeId);
            return set;
        },

        /**
         * Subscribe to link changes. Returns an unsubscribe function.
         */
        onChange(fn) {
            listeners.push(fn);
            return () => {
                const idx = listeners.indexOf(fn);
                if (idx >= 0) listeners.splice(idx, 1);
            };
        }
    };
})();
