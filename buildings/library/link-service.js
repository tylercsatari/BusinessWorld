/**
 * LinkService — DEPRECATED stub.
 * Scripts are now embedded in ideas/videos directly.
 * This stub exists so any lingering LinkService calls don't break.
 */
const LinkService = (() => {
    return {
        async linkScriptToIdea() {},
        async linkScriptToVideo() {},
        async unlinkScript() {},
        async unlinkFromIdea() {},
        async unlinkFromVideo() {},
        getLinkedScriptIds() { return new Set(); },
        onChange(fn) { return () => {}; }
    };
})();
