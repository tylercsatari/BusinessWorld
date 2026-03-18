/**
 * Research Facility UI — find viral YouTube videos sorted by popularity.
 * Includes Vault tab for browsing the locally-archived 100M+ Shorts database.
 */
const ResearchUI = (() => {
    let container = null;
    let cachedVideos = [];
    let loading = false;
    let expandedId = null;
    let framesCache = {};
    let framesLoading = {};
    let shortsDbCache = {}; // videoId -> DB entry (for cached frames)

    let currentTime = 'all';
    let currentType = 'all';
    let currentMinViews = 0;

    // Vault state
    let activeTab = 'vault'; // 'search' | 'vault'
    let vaultVideos = [];
    let vaultStats = null;
    let vaultPage = 1;
    let vaultTotalPages = 1;
    let vaultLoading = false;
    let vaultSort = 'views'; // 'views' | 'discoveredAt'
    let vaultFrameFilter = 'all'; // 'all' | 'done' | 'pending'

    const TIME_OPTIONS = [
        { key: 'week', label: 'This Week' },
        { key: 'month', label: 'This Month' },
        { key: 'year', label: 'This Year' },
        { key: 'all', label: 'All Time' },
    ];
    const TYPE_OPTIONS = [
        { key: 'all', label: 'All' },
        { key: 'long', label: 'Long-form' },
        { key: 'shorts', label: 'Shorts' },
    ];
    const VIEW_OPTIONS = [
        { key: 0, label: 'Any' },
        { key: 1000000, label: '1M+' },
        { key: 10000000, label: '10M+' },
        { key: 50000000, label: '50M+' },
        { key: 100000000, label: '100M+' },
    ];

    function formatViews(n) {
        if (n >= 1000000000) return (n / 1000000000).toFixed(1) + 'B';
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return String(n);
    }
    function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function escAttr(s) { return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
    function timeAgo(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        const now = Date.now();
        const sec = Math.floor((now - d) / 1000);
        if (sec < 60) return 'just now';
        if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
        if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
        return Math.floor(sec / 86400) + 'd ago';
    }

    /* ───── Search tab render ───── */

    function renderSearchTab() {
        return `
            <div class="research-presets" id="research-time-btns">
                ${TIME_OPTIONS.map(t => `<button class="research-preset-btn${currentTime === t.key ? ' active' : ''}" data-time="${t.key}">${t.label}</button>`).join('')}
            </div>
            <div class="research-presets" id="research-type-btns" style="border-top:none;padding-top:0">
                ${TYPE_OPTIONS.map(t => `<button class="research-preset-btn${t.key === 'shorts' ? ' trending' : ''}${currentType === t.key ? ' active' : ''}" data-type="${t.key}">${t.label}</button>`).join('')}
                <span style="width:1px;background:#333;margin:0 4px"></span>
                ${VIEW_OPTIONS.map(v => `<button class="research-preset-btn${currentMinViews === v.key ? ' active' : ''}" data-views="${v.key}">${v.label}</button>`).join('')}
                <span style="width:1px;background:#333;margin:0 4px"></span>
                <button class="research-search-btn" id="research-go-btn">Search</button>
            </div>
            <div class="research-status" id="research-status" style="display:none">
                <span class="research-status-count" id="research-count"></span>
            </div>
            <div id="shorts-db-status" style="display:none;padding:6px 12px;background:#1a1a2e;border-bottom:1px solid #333;font-size:12px;color:#8af"></div>
            <div class="research-results" id="research-results">
                <div class="research-empty">Pick your filters and tap Search.</div>
            </div>`;
    }

    /* ───── Vault tab render ───── */

    function renderVaultTab() {
        const statsHtml = vaultStats
            ? `<div class="vault-stats-bar">🗄️ ${vaultStats.totalVideos.toLocaleString()} Shorts archived &nbsp;·&nbsp; ✓ ${vaultStats.framesReady.toLocaleString()} frames ready &nbsp;·&nbsp; ⏳ ${vaultStats.framesPending.toLocaleString()} processing</div>`
            : '<div class="vault-stats-bar">Loading stats…</div>';

        return `
            <div class="vault-header">
                <div class="vault-header-top">
                    <div>
                        <h3 class="vault-title">100M+ Shorts Vault</h3>
                        <div class="vault-subtitle" id="vault-subtitle">${vaultStats ? `${vaultStats.totalVideos.toLocaleString()} archived · ${vaultStats.framesReady.toLocaleString()} frames ready · last crawled ${timeAgo(vaultStats.lastCrawled)}` : 'Loading…'}</div>
                    </div>
                    <button class="vault-refresh-btn" id="vault-refresh-btn">🔄</button>
                </div>
                ${statsHtml}
                <div class="vault-filters">
                    <div class="vault-filter-group">
                        <label>Sort:</label>
                        <button class="vault-filter-btn${vaultSort === 'views' ? ' active' : ''}" data-vault-sort="views">Views</button>
                        <button class="vault-filter-btn${vaultSort === 'discoveredAt' ? ' active' : ''}" data-vault-sort="discoveredAt">Newest Added</button>
                    </div>
                    <div class="vault-filter-group">
                        <label>Frames:</label>
                        <button class="vault-filter-btn${vaultFrameFilter === 'all' ? ' active' : ''}" data-vault-frame="all">All</button>
                        <button class="vault-filter-btn${vaultFrameFilter === 'done' ? ' active' : ''}" data-vault-frame="done">Frames Ready</button>
                        <button class="vault-filter-btn${vaultFrameFilter === 'pending' ? ' active' : ''}" data-vault-frame="pending">Pending</button>
                    </div>
                </div>
            </div>
            <div class="research-results" id="vault-results">
                ${vaultLoading && vaultVideos.length === 0
                    ? '<div class="research-loading"><div class="spinner"></div><div style="margin-top:8px">Loading vault…</div></div>'
                    : ''}
            </div>`;
    }

    /* ───── Main render ───── */

    function render() {
        return `
        <div class="research-panel">
            <div class="research-header">
                <h2>Research Facility</h2>
                <div class="vault-tabs">
                    <button class="vault-tab${activeTab === 'search' ? ' active' : ''}" data-tab="search">🔍 Search</button>
                    <button class="vault-tab${activeTab === 'vault' ? ' active' : ''}" data-tab="vault">🗄️ Vault</button>
                </div>
            </div>
            <div id="research-tab-content">
                ${activeTab === 'search' ? renderSearchTab() : renderVaultTab()}
            </div>
        </div>`;
    }

    async function fetchShortsDbStats() {
        const bar = document.getElementById('shorts-db-status');
        if (!bar) return;
        try {
            const res = await fetch('/api/shorts-db/stats');
            const stats = await res.json();
            if (stats.totalVideos > 0) {
                bar.style.display = '';
                bar.textContent = `Local DB: ${stats.totalVideos} Shorts archived (${stats.framesReady} with frames, ${stats.framesPending} pending)`;
            }
        } catch { /* ignore */ }
    }

    async function fetchShortsDbLookup(videoIds) {
        // Fetch the full shorts DB videos list and cache entries by videoId
        try {
            const res = await fetch('/api/shorts-db/videos?limit=200&minViews=0');
            const data = await res.json();
            shortsDbCache = {};
            for (const v of (data.videos || [])) {
                shortsDbCache[v.videoId] = v;
            }
        } catch { /* ignore */ }
    }

    /* ───── Vault data fetching ───── */

    async function fetchVaultStats() {
        try {
            const res = await fetch('/api/shorts-db/stats');
            vaultStats = await res.json();
        } catch { /* ignore */ }
    }

    async function fetchVaultVideos(page = 1, append = false) {
        vaultLoading = true;
        if (!append) renderVaultResults();
        try {
            const res = await fetch(`/api/shorts-db/videos?page=${page}&limit=50&sort=${vaultSort}&minViews=0`);
            const data = await res.json();
            if (append) {
                vaultVideos = vaultVideos.concat(data.videos || []);
            } else {
                vaultVideos = data.videos || [];
            }
            vaultPage = data.page || page;
            vaultTotalPages = data.pages || 1;
        } catch { /* ignore */ }
        vaultLoading = false;
        renderVaultResults();
    }

    function getFilteredVaultVideos() {
        if (vaultFrameFilter === 'all') return vaultVideos;
        if (vaultFrameFilter === 'done') return vaultVideos.filter(v => v.framesStatus === 'done');
        // 'pending' filter shows pending, processing, and failed
        return vaultVideos.filter(v => v.framesStatus !== 'done');
    }

    function renderVaultResults() {
        const results = document.getElementById('vault-results');
        if (!results) return;

        const filtered = getFilteredVaultVideos();

        if (!vaultLoading && filtered.length === 0 && vaultVideos.length === 0) {
            results.innerHTML = '<div class="research-empty">No videos in vault yet. The crawler runs every 30 minutes.</div>';
            return;
        }
        if (!vaultLoading && filtered.length === 0 && vaultVideos.length > 0) {
            results.innerHTML = '<div class="research-empty">No videos match this filter.</div>';
            return;
        }

        let html = filtered.map(v => {
            const hasDoneFrames = v.framesStatus === 'done' && v.framesR2Keys && v.framesR2Keys.length > 0;
            let badgeClass, badgeText;
            if (v.framesStatus === 'done') { badgeClass = 'vault-badge-done'; badgeText = '✓ Frames'; }
            else if (v.framesStatus === 'failed') { badgeClass = 'vault-badge-failed'; badgeText = '✗ Failed'; }
            else { badgeClass = 'vault-badge-pending'; badgeText = '⏳ Pending'; }

            let frameStripHtml = '';
            if (hasDoneFrames) {
                const frameFiles = v.framesR2Keys.slice(0, 3).map(k => k.split('/').pop());
                frameStripHtml = `<div class="vault-frame-strip">${frameFiles.map(f => `<img src="/api/shorts-db/frame/${escAttr(v.videoId)}/${escAttr(f)}" alt="" loading="lazy" />`).join('')}</div>`;
            }

            return `
            <div class="vault-card">
                <div class="vault-card-thumb">
                    <img src="${escAttr(v.thumbnail || '')}" alt="" loading="lazy" />
                    ${v.duration ? `<span class="research-thumb-duration">${escHtml(v.duration)}</span>` : ''}
                </div>
                <div class="vault-card-info">
                    <div class="vault-card-title" title="${escAttr(v.title)}">${escHtml(v.title)}</div>
                    <div class="vault-card-channel">${escHtml(v.channelTitle || '')}</div>
                    <div class="vault-card-meta">
                        <span class="vault-card-views">${formatViews(v.views)} views</span>
                        ${v.publishedAt ? `<span class="vault-card-published">Published: ${escHtml(v.publishedAt)}</span>` : ''}
                    </div>
                    <div class="vault-card-bottom">
                        <span class="vault-badge ${badgeClass}">${badgeText}</span>
                        <a href="https://www.youtube.com/shorts/${escAttr(v.videoId)}" target="_blank" class="vault-open-link">▶ Open</a>
                    </div>
                    ${frameStripHtml}
                </div>
            </div>`;
        }).join('');

        if (vaultPage < vaultTotalPages) {
            html += `<div class="vault-load-more-wrap"><button class="vault-load-more-btn" id="vault-load-more">${vaultLoading ? 'Loading…' : 'Load More'}</button></div>`;
        }
        if (vaultLoading && vaultVideos.length > 0) {
            html += '<div class="research-loading" style="padding:12px"><div class="spinner" style="width:18px;height:18px;border-width:2px;display:inline-block;vertical-align:middle"></div></div>';
        }

        results.innerHTML = html;
        bindVaultResultEvents();
    }

    function bindVaultResultEvents() {
        document.getElementById('vault-load-more')?.addEventListener('click', () => {
            if (!vaultLoading && vaultPage < vaultTotalPages) {
                fetchVaultVideos(vaultPage + 1, true);
            }
        });
    }

    /* ───── Tab switching ───── */

    function switchTab(tab) {
        if (tab === activeTab) return;
        activeTab = tab;
        const content = document.getElementById('research-tab-content');
        if (!content) return;

        // Update tab buttons
        container.querySelectorAll('.vault-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));

        if (tab === 'search') {
            content.innerHTML = renderSearchTab();
            bindSearchEvents();
            fetchShortsDbStats();
        } else {
            content.innerHTML = renderVaultTab();
            bindVaultEvents();
            // Fetch fresh data on tab open
            fetchVaultStats().then(() => {
                updateVaultSubtitle();
                updateVaultStatsBar();
            });
            fetchVaultVideos(1);
        }
    }

    function updateVaultSubtitle() {
        const el = document.getElementById('vault-subtitle');
        if (el && vaultStats) {
            el.textContent = `${vaultStats.totalVideos.toLocaleString()} archived · ${vaultStats.framesReady.toLocaleString()} frames ready · last crawled ${timeAgo(vaultStats.lastCrawled)}`;
        }
    }

    function updateVaultStatsBar() {
        const bar = container?.querySelector('.vault-stats-bar');
        if (bar && vaultStats) {
            bar.innerHTML = `🗄️ ${vaultStats.totalVideos.toLocaleString()} Shorts archived &nbsp;·&nbsp; ✓ ${vaultStats.framesReady.toLocaleString()} frames ready &nbsp;·&nbsp; ⏳ ${vaultStats.framesPending.toLocaleString()} processing`;
        }
    }

    /* ───── Event binding ───── */

    function bindTabEvents() {
        container.querySelectorAll('.vault-tab').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });
    }

    function bindSearchEvents() {
        // Time buttons — set state only
        container.querySelectorAll('#research-time-btns .research-preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                currentTime = btn.dataset.time;
                container.querySelectorAll('#research-time-btns .research-preset-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                cachedVideos = [];
            });
        });
        // Type buttons — set state only
        container.querySelectorAll('#research-type-btns .research-preset-btn[data-type]').forEach(btn => {
            btn.addEventListener('click', () => {
                currentType = btn.dataset.type;
                container.querySelectorAll('#research-type-btns [data-type]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                cachedVideos = [];
                fetchShortsDbStats();
            });
        });
        // View threshold
        container.querySelectorAll('#research-type-btns .research-preset-btn[data-views]').forEach(btn => {
            btn.addEventListener('click', () => {
                currentMinViews = parseInt(btn.dataset.views) || 0;
                container.querySelectorAll('#research-type-btns [data-views]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (cachedVideos.length > 0) renderResults();
                else doSearch();
            });
        });
        // Search button
        document.getElementById('research-go-btn')?.addEventListener('click', () => { cachedVideos = []; doSearch(); });
    }

    function bindVaultEvents() {
        // Refresh button
        document.getElementById('vault-refresh-btn')?.addEventListener('click', () => {
            vaultVideos = [];
            vaultPage = 1;
            fetchVaultStats().then(() => { updateVaultSubtitle(); updateVaultStatsBar(); });
            fetchVaultVideos(1);
        });
        // Sort buttons
        container.querySelectorAll('[data-vault-sort]').forEach(btn => {
            btn.addEventListener('click', () => {
                vaultSort = btn.dataset.vaultSort;
                container.querySelectorAll('[data-vault-sort]').forEach(b => b.classList.toggle('active', b.dataset.vaultSort === vaultSort));
                vaultVideos = [];
                vaultPage = 1;
                fetchVaultVideos(1);
            });
        });
        // Frame filter buttons
        container.querySelectorAll('[data-vault-frame]').forEach(btn => {
            btn.addEventListener('click', () => {
                vaultFrameFilter = btn.dataset.vaultFrame;
                container.querySelectorAll('[data-vault-frame]').forEach(b => b.classList.toggle('active', b.dataset.vaultFrame === vaultFrameFilter));
                renderVaultResults(); // client-side filter only
            });
        });
    }

    function bindEvents() {
        bindTabEvents();
        if (activeTab === 'search') bindSearchEvents();
        else bindVaultEvents();
    }

    async function doSearch() {
        if (loading) return;
        loading = true;
        cachedVideos = [];
        expandedId = null;
        const results = document.getElementById('research-results');
        const goBtn = document.getElementById('research-go-btn');
        if (goBtn) { goBtn.disabled = true; goBtn.textContent = 'Searching...'; }
        if (results) results.innerHTML = '<div class="research-loading"><div class="spinner"></div><div style="margin-top:8px">Searching YouTube (' + currentTime + ', ' + currentType + ')...</div></div>';

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 55000);
            const res = await fetch(`/api/research/popular?timeRange=${currentTime}&type=${currentType}`, { signal: controller.signal });
            clearTimeout(timeout);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed');
            cachedVideos = data.videos || [];
            // Fetch shorts DB lookup for cached frames
            await fetchShortsDbLookup();
            renderResults();
        } catch (e) {
            if (results) results.innerHTML = `<div class="research-error">${escHtml(e.message)}<br><br><button class="research-search-btn" onclick="ResearchUI._retry()">Retry</button></div>`;
        } finally {
            loading = false;
            if (goBtn) { goBtn.disabled = false; goBtn.textContent = 'Search'; }
        }
    }

    function renderResults() {
        const results = document.getElementById('research-results');
        const status = document.getElementById('research-status');
        const countEl = document.getElementById('research-count');
        if (!results) return;

        const filtered = currentMinViews > 0
            ? cachedVideos.filter(v => v.views >= currentMinViews)
            : cachedVideos;

        if (status) status.style.display = filtered.length > 0 ? '' : 'none';
        if (countEl) countEl.textContent = `${filtered.length} video${filtered.length !== 1 ? 's' : ''} (${cachedVideos.length} loaded)`;

        if (filtered.length === 0 && cachedVideos.length > 0) {
            const topView = formatViews(cachedVideos[0].views);
            results.innerHTML = `<div class="research-empty">No videos over ${formatViews(currentMinViews)} views in this set. ${cachedVideos.length} videos loaded, highest is ${topView}. Try a lower view threshold or tap Search again.</div>`;
            return;
        }
        if (filtered.length === 0) {
            results.innerHTML = '<div class="research-empty">Pick your filters and tap Search.</div>';
            return;
        }

        results.innerHTML = filtered.map(v => {
            const isExpanded = expandedId === v.videoId;
            const frames = framesCache[v.videoId];
            const isFramesLoading = framesLoading[v.videoId];
            // Check shorts DB for pre-cached frames
            const dbEntry = shortsDbCache[v.videoId];
            const dbFramesDone = dbEntry && dbEntry.framesStatus === 'done' && dbEntry.framesR2Keys && dbEntry.framesR2Keys.length > 0;
            let detailHtml = '';
            if (isExpanded) {
                let framesHtml = '';
                if (isFramesLoading) {
                    framesHtml = '<div class="research-frames-loading"><div class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;vertical-align:middle"></div> Downloading frames...</div>';
                } else if (frames && frames.length > 0) {
                    framesHtml = `<div class="research-frames-strip">${frames.map(f => `<img src="/api/research/frame/${v.videoId}/${f}" alt="${f}" />`).join('')}</div>`;
                } else if (dbFramesDone) {
                    // Show frames from shorts-db (already archived)
                    const dbFrameFiles = dbEntry.framesR2Keys.map(k => k.split('/').pop());
                    framesHtml = `<div class="research-frames-strip">${dbFrameFiles.map(f => `<img src="/api/shorts-db/frame/${v.videoId}/${f}" alt="${f}" />`).join('')}</div>`;
                }
                const hasAnyFrames = (frames && frames.length > 0) || dbFramesDone;
                detailHtml = `<div class="research-detail">
                    <div class="research-detail-actions">
                        <button class="research-detail-btn primary" data-action="grab-frames" data-vid="${escAttr(v.videoId)}"${hasAnyFrames ? ' disabled' : ''}>${hasAnyFrames ? 'Frames Available' : 'Grab First Frames'}</button>
                        <a href="https://www.youtube.com/watch?v=${escAttr(v.videoId)}" target="_blank" class="research-detail-btn">Open on YouTube</a>
                    </div>
                    ${framesHtml}
                </div>`;
            }
            return `
            <div class="research-video-card${isExpanded ? ' expanded' : ''}" data-vid="${escAttr(v.videoId)}">
                <div class="research-thumb">
                    <img src="${escAttr(v.thumbnail || '')}" alt="" loading="lazy" />
                    ${v.duration ? `<span class="research-thumb-duration">${escHtml(v.duration)}</span>` : ''}
                </div>
                <div class="research-video-info">
                    <div class="research-video-title" title="${escAttr(v.title)}">${escHtml(v.title)}</div>
                    <div class="research-video-channel">${escHtml(v.channelTitle)}${v.publishedAt ? ' &middot; ' + escHtml(v.publishedAt) : ''}</div>
                    <div class="research-video-stats">
                        <span class="research-stat"><span class="research-stat-value">${formatViews(v.views)}</span> <span class="research-stat-label">views</span></span>
                        ${dbEntry ? '<span class="research-stat" style="color:#8af;font-size:10px">IN DB</span>' : ''}
                    </div>
                    ${detailHtml}
                </div>
            </div>`;
        }).join('');

        results.querySelectorAll('.research-video-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('button') || e.target.closest('a')) return;
                expandedId = expandedId === card.dataset.vid ? null : card.dataset.vid;
                renderResults();
            });
        });
        results.querySelectorAll('[data-action="grab-frames"]').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); grabFrames(btn.dataset.vid); });
        });
    }

    async function grabFrames(videoId) {
        if (framesLoading[videoId] || framesCache[videoId]) return;
        framesLoading[videoId] = true;
        renderResults();
        try {
            const res = await fetch('/api/research/grab-frames', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videoId, seconds: 10 })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed');
            framesCache[videoId] = data.frames || [];
        } catch (e) { console.warn('Grab frames failed:', e.message); }
        finally { framesLoading[videoId] = false; renderResults(); }
    }

    return {
        open(bodyEl) {
            container = bodyEl;
            activeTab = 'vault'; // open to Vault by default
            container.innerHTML = render();
            bindEvents();
            // Fetch vault data on open
            fetchVaultStats().then(() => {
                updateVaultSubtitle();
                updateVaultStatsBar();
            });
            fetchVaultVideos(1);
        },
        _retry() { doSearch(); },
        close() {
            container = null; cachedVideos = []; expandedId = null;
            framesCache = {}; framesLoading = {}; loading = false;
            shortsDbCache = {};
            // Reset vault state
            vaultVideos = []; vaultStats = null; vaultPage = 1;
            vaultTotalPages = 1; vaultLoading = false;
            vaultSort = 'views'; vaultFrameFilter = 'all';
        }
    };
})();

BuildingRegistry.register('Science Center', {
    open: (bodyEl, opts) => ResearchUI.open(bodyEl, opts),
    close: () => ResearchUI.close()
});
