/**
 * HtmlUtils — shared config cache + HTML escaping utilities.
 * Replaces NotionHelpers after Notion → R2 migration.
 */
const HtmlUtils = (() => {
    let _config = null;
    let _configPromise = null;

    return {
        async getConfig() {
            if (_config) return _config;
            if (_configPromise) return _configPromise;
            _configPromise = (async () => {
                try {
                    const res = await fetch('/api/config');
                    if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
                    _config = await res.json();
                } catch (e) {
                    console.warn('HtmlUtils: config load failed', e);
                }
                return _config || {};
            })();
            try { return await _configPromise; } finally { _configPromise = null; }
        },

        escHtml(s) {
            const d = document.createElement('div');
            d.textContent = s || '';
            return d.innerHTML;
        },

        escAttr(s) {
            return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        }
    };
})();
