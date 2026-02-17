/**
 * Movie Theatre UI — Dropbox file browser with media preview.
 * Two-page navigation: file browser <-> preview with slide animation.
 */
const MovieTheatreUI = (() => {
    let container = null;
    let rootPath = '';
    let currentPath = '';
    let breadcrumb = [];   // [{name, path}]
    let entries = [];
    let currentPage = 'browser'; // 'browser' or 'preview'

    // --- Config ---
    async function loadConfig() {
        if (rootPath) return;
        try {
            const res = await fetch('/api/config');
            const cfg = await res.json();
            if (cfg.dropbox && cfg.dropbox.rootPath) rootPath = cfg.dropbox.rootPath;
        } catch (e) { console.warn('MovieTheatre: config load failed', e); }
    }

    // --- Dropbox API helpers ---
    async function listFolder(path) {
        const allEntries = [];
        try {
            let res = await fetch('/api/dropbox/list_folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: path || '', include_media_info: true })
            });
            let data = await res.json();
            if (data.error) throw new Error(data.error_summary || 'Dropbox error');
            allEntries.push(...(data.entries || []));

            while (data.has_more) {
                res = await fetch('/api/dropbox/list_folder/continue', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cursor: data.cursor })
                });
                data = await res.json();
                allEntries.push(...(data.entries || []));
            }
        } catch (e) {
            console.warn('MovieTheatre: list folder failed', e);
        }

        // Sort: folders first, then alphabetically
        allEntries.sort((a, b) => {
            if (a['.tag'] !== b['.tag']) return a['.tag'] === 'folder' ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });

        return allEntries;
    }

    async function getTemporaryLink(path) {
        try {
            const res = await fetch('/api/dropbox/get_temporary_link', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path })
            });
            const data = await res.json();
            return data.link || null;
        } catch (e) {
            console.warn('MovieTheatre: get link failed', e);
            return null;
        }
    }

    // --- File type helpers ---
    function getFileExt(name) {
        const dot = name.lastIndexOf('.');
        return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    }

    function getFileIcon(entry) {
        if (entry['.tag'] === 'folder') return '\uD83D\uDCC1';
        const ext = getFileExt(entry.name);
        const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv'];
        const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tiff'];
        const audioExts = ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'];
        const docExts = ['pdf', 'doc', 'docx', 'txt', 'rtf', 'pages'];
        if (videoExts.includes(ext)) return '\uD83C\uDFAC';
        if (imageExts.includes(ext)) return '\uD83D\uDDBC\uFE0F';
        if (audioExts.includes(ext)) return '\uD83C\uDFB5';
        if (docExts.includes(ext)) return '\uD83D\uDCC4';
        return '\uD83D\uDCC2';
    }

    function isPreviewable(name) {
        const ext = getFileExt(name);
        const previewExts = ['mp4', 'mov', 'webm', 'm4v', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
        return previewExts.includes(ext);
    }

    function isVideo(name) {
        const ext = getFileExt(name);
        return ['mp4', 'mov', 'webm', 'm4v'].includes(ext);
    }

    function isImage(name) {
        const ext = getFileExt(name);
        return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
    }

    function hasThumbnail(entry) {
        if (entry['.tag'] === 'folder') return false;
        const ext = getFileExt(entry.name);
        const thumbExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'heic',
                           'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv'];
        return thumbExts.includes(ext);
    }

    function stopActiveVideo() {
        if (!container) return;
        const video = container.querySelector('video');
        if (video) { video.pause(); video.src = ''; }
    }

    // --- Navigation ---
    async function navigateTo(path) {
        currentPath = path;
        buildBreadcrumb();
        renderBreadcrumb();
        showLoading();

        entries = await listFolder(path);
        renderGrid();
    }

    function buildBreadcrumb() {
        breadcrumb = [];
        if (!rootPath) return;

        // Root segment
        const rootName = rootPath.split('/').filter(Boolean).pop() || 'Root';
        breadcrumb.push({ name: rootName, path: rootPath });

        // Additional segments if we're deeper than root
        if (currentPath && currentPath !== rootPath) {
            const relative = currentPath.slice(rootPath.length);
            const parts = relative.split('/').filter(Boolean);
            let accumulated = rootPath;
            for (const part of parts) {
                accumulated += '/' + part;
                breadcrumb.push({ name: part, path: accumulated });
            }
        }
    }

    function showBrowserPage() {
        stopActiveVideo();
        currentPage = 'browser';
        const panel = container.querySelector('.theatre-panel');
        if (!panel) return;
        panel.classList.remove('show-preview');
        panel.classList.add('show-browser');
    }

    function showPreviewPage() {
        currentPage = 'preview';
        const panel = container.querySelector('.theatre-panel');
        if (!panel) return;
        panel.classList.remove('show-browser');
        panel.classList.add('show-preview');
    }

    // --- Render ---
    function render(bodyEl) {
        container = bodyEl;
        container.innerHTML = `
            <div class="theatre-panel show-browser">
                <div class="theatre-page theatre-browser-page">
                    <div class="theatre-header">
                        <h2 class="theatre-heading">\uD83C\uDFAC</h2>
                        <div class="theatre-breadcrumb" id="theatre-breadcrumb"></div>
                    </div>
                    <div class="theatre-grid" id="theatre-grid">
                        <div class="theatre-loading">Loading...</div>
                    </div>
                </div>
                <div class="theatre-page theatre-preview-page">
                    <div class="theatre-preview-toolbar" id="theatre-preview-toolbar"></div>
                    <div class="theatre-preview-body" id="theatre-preview-body"></div>
                </div>
            </div>
        `;
    }

    function showLoading() {
        const grid = document.getElementById('theatre-grid');
        if (grid) grid.innerHTML = '<div class="theatre-loading">Loading...</div>';
    }

    function renderBreadcrumb() {
        const el = document.getElementById('theatre-breadcrumb');
        if (!el) return;

        el.innerHTML = breadcrumb.map((b, i) => {
            const isLast = i === breadcrumb.length - 1;
            const sep = i > 0 ? '<span class="theatre-breadcrumb-sep">/</span>' : '';
            const cls = isLast ? 'theatre-breadcrumb-item current' : 'theatre-breadcrumb-item';
            return `${sep}<button class="${cls}" data-path="${escAttr(b.path)}">${escHtml(b.name)}</button>`;
        }).join('');

        el.querySelectorAll('.theatre-breadcrumb-item:not(.current)').forEach(btn => {
            btn.addEventListener('click', () => navigateTo(btn.dataset.path));
        });

        // Scroll breadcrumb to end
        el.scrollLeft = el.scrollWidth;
    }

    function renderGrid() {
        const grid = document.getElementById('theatre-grid');
        if (!grid) return;

        if (entries.length === 0) {
            grid.innerHTML = `
                <div class="theatre-empty" style="grid-column: 1 / -1;">
                    <div class="theatre-empty-icon">\uD83C\uDFAC</div>
                    <div>This folder is empty</div>
                </div>
            `;
            return;
        }

        grid.innerHTML = entries.map((e, i) => {
            const useThumb = hasThumbnail(e);
            const iconHtml = useThumb
                ? `<div class="theatre-card-thumb" data-path="${escAttr(e.path_lower)}"><div class="theatre-card-icon">${getFileIcon(e)}</div></div>`
                : `<div class="theatre-card-icon">${getFileIcon(e)}</div>`;
            return `<div class="theatre-card" data-index="${i}">${iconHtml}<div class="theatre-card-name">${escHtml(e.name)}</div></div>`;
        }).join('');

        grid.querySelectorAll('.theatre-card').forEach(card => {
            card.addEventListener('click', () => handleCardClick(parseInt(card.dataset.index)));
        });

        // Load thumbnails lazily
        grid.querySelectorAll('.theatre-card-thumb').forEach(thumb => {
            const path = thumb.dataset.path;
            const img = new Image();
            img.onload = () => {
                thumb.innerHTML = '';
                thumb.appendChild(img);
            };
            img.src = `/api/dropbox/get_thumbnail?path=${encodeURIComponent(path)}`;
        });
    }

    function renderPreview(name, link) {
        const toolbar = document.getElementById('theatre-preview-toolbar');
        const body = document.getElementById('theatre-preview-body');
        if (!toolbar || !body) return;

        toolbar.innerHTML = `
            <button class="theatre-back-btn" id="theatre-back-btn">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                Back
            </button>
            <div class="theatre-preview-title">${escHtml(name)}</div>
        `;

        if (isVideo(name)) {
            body.innerHTML = `<video controls autoplay src="${escAttr(link)}"></video>`;
        } else if (isImage(name)) {
            body.innerHTML = `<img src="${escAttr(link)}" alt="${escAttr(name)}">`;
        } else {
            body.innerHTML = `<a class="theatre-preview-download" href="${escAttr(link)}" target="_blank" rel="noopener">\uD83D\uDCE5 Download</a>`;
        }

        document.getElementById('theatre-back-btn').addEventListener('click', () => showBrowserPage());
    }

    // --- Actions ---
    async function handleCardClick(index) {
        const entry = entries[index];
        if (!entry) return;

        if (entry['.tag'] === 'folder') {
            await navigateTo(entry.path_lower);
            return;
        }

        // File — get temporary link
        if (isPreviewable(entry.name)) {
            showPreviewPage();
            const body = document.getElementById('theatre-preview-body');
            if (body) body.innerHTML = '<div class="theatre-loading">Loading preview...</div>';

            const toolbar = document.getElementById('theatre-preview-toolbar');
            if (toolbar) {
                toolbar.innerHTML = `
                    <button class="theatre-back-btn" id="theatre-back-btn">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                        Back
                    </button>
                    <div class="theatre-preview-title">${escHtml(entry.name)}</div>
                `;
                document.getElementById('theatre-back-btn').addEventListener('click', () => showBrowserPage());
            }

            const link = await getTemporaryLink(entry.path_lower);
            if (link) {
                renderPreview(entry.name, link);
            } else {
                if (body) body.innerHTML = '<div class="theatre-empty">Could not load preview</div>';
            }
        } else {
            // Non-previewable: open link in new tab
            const link = await getTemporaryLink(entry.path_lower);
            if (link) window.open(link, '_blank');
        }
    }

    // --- Helpers ---
    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    function escAttr(s) {
        return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    // --- Public ---
    return {
        async open(bodyEl) {
            await loadConfig();
            render(bodyEl);
            await navigateTo(rootPath);
        },
        close() {
            stopActiveVideo();
            container = null;
            entries = [];
            breadcrumb = [];
            currentPath = '';
            currentPage = 'browser';
        }
    };
})();

BuildingRegistry.register('Movie Theatre', {
    open: (bodyEl) => MovieTheatreUI.open(bodyEl),
    close: () => MovieTheatreUI.close()
});
