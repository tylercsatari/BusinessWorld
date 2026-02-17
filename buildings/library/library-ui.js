/**
 * Library UI — Notion-connected notes/script editor.
 * Creates pages inside a Notion parent page (Videos page).
 */
const LibraryUI = (() => {
    let container = null;
    let videosPageId = '';

    async function loadConfig() {
        if (videosPageId) return;
        try {
            const res = await fetch('/api/config');
            const cfg = await res.json();
            if (cfg.notion && cfg.notion.videosPageId) {
                videosPageId = cfg.notion.videosPageId;
            }
        } catch (e) {
            console.warn('Failed to load Notion config:', e);
        }
    }

    async function fetchScripts() {
        if (!videosPageId) return [];
        try {
            const res = await fetch(`/api/notion/blocks/${videosPageId}/children`);
            const data = await res.json();
            if (!data.results) return [];
            // Filter for child_page blocks (these are the script pages)
            return data.results
                .filter(b => b.type === 'child_page')
                .map(b => ({
                    id: b.id,
                    title: b.child_page.title,
                    created: b.created_time
                }));
        } catch (e) {
            console.warn('Failed to fetch scripts:', e);
            return [];
        }
    }

    async function saveScript(title, content) {
        if (!videosPageId) throw new Error('Notion not configured');
        // Split content into paragraph blocks (Notion max 2000 chars per block)
        const paragraphs = content.split('\n\n').filter(p => p.trim());
        const children = paragraphs.map(p => ({
            object: 'block',
            type: 'paragraph',
            paragraph: {
                rich_text: [{ type: 'text', text: { content: p.trim() } }]
            }
        }));
        // If no content, add an empty paragraph
        if (children.length === 0) {
            children.push({
                object: 'block',
                type: 'paragraph',
                paragraph: { rich_text: [{ type: 'text', text: { content: '' } }] }
            });
        }

        const res = await fetch('/api/notion/pages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                parent: { page_id: videosPageId },
                properties: {
                    title: { title: [{ text: { content: title } }] }
                },
                children
            })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Notion API error: ${err}`);
        }
        return await res.json();
    }

    function renderScriptList(listEl, scripts) {
        if (scripts.length === 0) {
            listEl.innerHTML = '<div class="library-empty">No scripts yet. Create one!</div>';
            return;
        }
        listEl.innerHTML = scripts.map(s => {
            const date = new Date(s.created).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            return `<div class="library-script-item">
                <div class="library-script-title">${s.title}</div>
                <div class="library-script-date">${date}</div>
            </div>`;
        }).join('');
    }

    function render(bodyEl) {
        container = bodyEl;
        container.innerHTML = `
            <div class="library-panel">
                <div class="library-header">
                    <h2 class="library-title">Library</h2>
                </div>
                <div class="library-content">
                    <div class="library-sidebar">
                        <h3 class="library-section-title">Scripts</h3>
                        <div class="library-script-list" id="library-script-list">
                            <div class="library-empty">Loading...</div>
                        </div>
                        <button class="library-refresh-btn" id="library-refresh-btn">Refresh</button>
                    </div>
                    <div class="library-editor">
                        <h3 class="library-section-title">New Script</h3>
                        <input type="text" class="library-title-input" id="library-title-input" placeholder="_____ Script" />
                        <textarea class="library-textarea" id="library-textarea" placeholder="Write your script content here..."></textarea>
                        <div class="library-actions">
                            <button class="library-save-btn" id="library-save-btn">Save to Notion</button>
                            <div class="library-status" id="library-status"></div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Wire up events
        document.getElementById('library-save-btn').addEventListener('click', handleSave);
        document.getElementById('library-refresh-btn').addEventListener('click', loadScripts);

        loadScripts();
    }

    async function loadScripts() {
        const listEl = document.getElementById('library-script-list');
        if (!listEl) return;
        listEl.innerHTML = '<div class="library-empty">Loading...</div>';
        const scripts = await fetchScripts();
        renderScriptList(listEl, scripts);
    }

    async function handleSave() {
        const titleInput = document.getElementById('library-title-input');
        const textarea = document.getElementById('library-textarea');
        const statusEl = document.getElementById('library-status');
        const saveBtn = document.getElementById('library-save-btn');

        const title = titleInput.value.trim();
        const content = textarea.value.trim();

        if (!title) {
            statusEl.textContent = 'Please enter a title.';
            statusEl.className = 'library-status library-status-error';
            return;
        }

        saveBtn.disabled = true;
        statusEl.textContent = 'Saving...';
        statusEl.className = 'library-status';

        try {
            await saveScript(title, content);
            statusEl.textContent = 'Saved!';
            statusEl.className = 'library-status library-status-success';
            titleInput.value = '';
            textarea.value = '';
            // Refresh the list
            loadScripts();
        } catch (e) {
            statusEl.textContent = e.message;
            statusEl.className = 'library-status library-status-error';
        } finally {
            saveBtn.disabled = false;
        }
    }

    return {
        async open(bodyEl) {
            await loadConfig();
            render(bodyEl);
        },
        close() {
            container = null;
        }
    };
})();

BuildingRegistry.register('Library', {
    open: (bodyEl) => LibraryUI.open(bodyEl),
    close: () => LibraryUI.close()
});
