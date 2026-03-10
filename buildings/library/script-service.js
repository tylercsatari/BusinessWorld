/**
 * Script Service — DEPRECATED stub.
 * Scripts are now embedded in ideas (idea.script field).
 * This stub exists so ScriptService.sync() calls in other buildings don't break.
 */
const ScriptService = (() => {
    return {
        async sync() { return []; },
        getAll() { return []; },
        getById() { return null; },
        async loadContent() { return { meta: { project: '' }, text: '' }; },
        async saveContent() {},
        async create() { return null; },
        async remove() {},
        ensureScriptSuffix(t) { return t; }
    };
})();
