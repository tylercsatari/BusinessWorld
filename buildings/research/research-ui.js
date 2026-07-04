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
    // Last-Year dataset (the big crawl: last-year vertical shorts 10k–100M+, full 720p on R2, with metadata + outlier)
    let lyVideos = [], lyStats = null, lyLoading = false, lySort = 'recent', lyKind = 'shorts'; // sort: 'recent'|'views'|'outlier'; kind: 'shorts'|'long'

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

    function vaultSubtitleText() {
        if (!vaultStats) return 'Loading…';
        let s = `${vaultStats.totalVideos.toLocaleString()} archived`;
        if (vaultStats.framesReady > 0) s += ` · ${vaultStats.framesReady.toLocaleString()} frames ready`;
        s += ` · last crawled ${timeAgo(vaultStats.lastCrawled)}`;
        return s;
    }

    function renderVaultTab() {
        return `
            <div class="vault-header">
                <div class="vault-header-top">
                    <div>
                        <h3 class="vault-title">100M+ Shorts Vault</h3>
                        <div class="vault-subtitle" id="vault-subtitle">${vaultSubtitleText()}</div>
                    </div>
                    <button class="vault-refresh-btn" id="vault-refresh-btn">🔄</button>
                </div>
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
                    <button class="vault-tab${activeTab === 'lastyear' ? ' active' : ''}" data-tab="lastyear">📅 Last Year</button>
                </div>
            </div>
            <div id="research-tab-content">
                ${activeTab === 'search' ? renderSearchTab() : activeTab === 'lastyear' ? renderLastYearTab() : renderVaultTab()}
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

    /* ───── Last-Year dataset tab ───── */

    function renderLastYearTab() {
        const s = lyStats || {};
        const sub = s.stored != null
            ? `${(s.stored || 0).toLocaleString()} stored on R2 · ${(s.discovered || 0).toLocaleString()} discovered · ${s.removed ? s.removed + ' horizontals removed · ' : ''}target ${(s.target || 100000).toLocaleString()}`
            : 'Loading…';
        const sortBtn = (k, l) => `<button class="vault-filter-btn${lySort === k ? ' active' : ''}" data-ly-sort="${k}">${l}</button>`;
        return `
            <div class="vault-header">
                <div class="vault-header-top">
                    <div><h3 class="vault-title">📅 Last-Year Dataset</h3>
                        <div class="vault-subtitle" id="ly-subtitle">${sub}</div></div>
                    <button class="vault-refresh-btn" id="ly-refresh-btn">🔄</button>
                </div>
                <div class="vault-filters">
                    <div class="vault-filter-group"><label>Type:</label>
                        <button class="vault-filter-btn${lyKind === 'shorts' ? ' active' : ''}" data-ly-kind="shorts">Shorts</button><button class="vault-filter-btn${lyKind === 'long' ? ' active' : ''}" data-ly-kind="long">Long</button></div>
                    <div class="vault-filter-group"><label>Sort:</label>
                    ${sortBtn('recent', 'Newest')}${sortBtn('views', 'Views')}${sortBtn('outlier', 'Outlier')}</div></div>
            </div>
            <div class="research-results" id="lastyear-results">${lyLoading && lyVideos.length === 0
                ? '<div class="research-loading"><div class="spinner"></div><div style="margin-top:8px">Loading dataset…</div></div>' : ''}</div>`;
    }

    function lyCard(v) {
        const date = v.uploadDate ? `${v.uploadDate.slice(0, 4)}-${v.uploadDate.slice(4, 6)}-${v.uploadDate.slice(6, 8)}` : (v.publishedAt || '');
        const subs = v.subs != null ? `${formatViews(v.subs)} subs` : '';
        const out = v.outlier ? `<span class="vault-badge" style="background:${v.outlier >= 3 ? 'rgba(34,197,94,.18)' : 'rgba(148,163,184,.15)'};color:${v.outlier >= 3 ? '#4ade80' : '#94a3b8'}" title="views ÷ subscribers — how far it beat the channel's size">${v.outlier >= 1 ? v.outlier + '× subs' : v.outlier + '× subs'}</span>` : (v.src === 'vault' ? '<span class="vault-badge vault-badge-done">100M set</span>' : '');
        return `
            <div class="vault-card">
                <div class="vault-card-thumb"><img src="https://i.ytimg.com/vi/${escAttr(v.videoId)}/hqdefault.jpg" alt="" loading="lazy" />${(() => { const d = v.duration || (v.durationSec ? Math.floor(v.durationSec / 60) + ':' + String(Math.round(v.durationSec % 60)).padStart(2, '0') : ''); return d ? `<span class="research-thumb-duration">${escHtml(String(d))}</span>` : ''; })()}</div>
                <div class="vault-card-info">
                    <div class="vault-card-title" title="${escAttr(v.title || '')}">${escHtml(v.title || '')}</div>
                    <div class="vault-card-channel">${v.channelUrl ? `<a href="${escAttr(v.channelUrl)}" target="_blank" style="color:inherit;text-decoration:none">${escHtml(v.channel || '')}</a>` : escHtml(v.channel || '')}${subs ? ' · ' + subs : ''}</div>
                    <div class="vault-card-meta"><span class="vault-card-views">${formatViews(v.views)} views</span>${date ? `<span class="vault-card-published">${escHtml(date)}</span>` : ''}</div>
                    <div class="vault-card-bottom">${out}<a href="${escAttr(v.url || (v.kind === 'long' ? 'https://www.youtube.com/watch?v=' + v.videoId : 'https://www.youtube.com/shorts/' + v.videoId))}" target="_blank" class="vault-open-link">▶ Open</a></div>
                </div>
            </div>`;
    }

    function renderLastYearResults() {
        const el = document.getElementById('lastyear-results');
        if (!el) return;
        if (!lyLoading && lyVideos.length === 0) { el.innerHTML = '<div class="research-empty">No videos yet — the crawler is downloading. Refresh in a minute.</div>'; return; }
        el.innerHTML = lyVideos.map(lyCard).join('') + (lyLoading ? '<div class="research-loading" style="padding:12px"><div class="spinner" style="width:18px;height:18px;border-width:2px;display:inline-block"></div></div>' : '');
    }

    async function fetchLastYearVideos() {
        lyLoading = true; renderLastYearResults();
        try {
            if (lyKind === 'long') {
                // Long-form corpus (title+thumbnail only) — longform-crawler.js → /api/longquant/*
                const [vidR, statR] = await Promise.all([
                    fetch(`/api/longquant/videos?limit=300&sort=${lySort}`).then(r => r.json()).catch(() => ({ videos: [] })),
                    fetch('/api/longquant/stats').then(r => r.json()).catch(() => null),
                ]);
                lyStats = statR;
                lyVideos = (vidR.videos || []).map(v => ({ ...v, src: 'longform', kind: 'long' }));
                if (lySort === 'views') lyVideos.sort((a, b) => (b.views || 0) - (a.views || 0));
                else if (lySort === 'outlier') lyVideos.sort((a, b) => (b.outlier || 0) - (a.outlier || 0));
            } else {
                const [libR, statR, shR] = await Promise.all([
                    fetch(`/api/library/videos?limit=300&sort=${lySort}`).then(r => r.json()).catch(() => ({ videos: [] })),
                    fetch('/api/library/stats').then(r => r.json()).catch(() => null),
                    fetch('/api/shorts-db/videos?limit=400&sort=views&minViews=0').then(r => r.json()).catch(() => ({ videos: [] })),
                ]);
                lyStats = statR;
                const lib = (libR.videos || []).map(v => ({ ...v, src: 'library' }));
                const seen = new Set(lib.map(v => v.videoId));
                const vaultLY = (shR.videos || []).filter(v => !/year/i.test(v.publishedAt || '') && !seen.has(v.videoId))
                    .map(v => ({ videoId: v.videoId, title: v.title, channel: v.channelTitle, views: v.views, publishedAt: v.publishedAt, duration: v.duration, src: 'vault' }));
                lyVideos = lib.concat(vaultLY);
                if (lySort === 'views') lyVideos.sort((a, b) => (b.views || 0) - (a.views || 0));
                else if (lySort === 'outlier') lyVideos.sort((a, b) => (b.outlier || 0) - (a.outlier || 0));
            }
        } catch (e) { /* ignore */ }
        lyLoading = false;
        const sub = document.getElementById('ly-subtitle');
        if (sub && lyStats) sub.textContent = `${(lyStats.stored || 0).toLocaleString()} stored on R2 · ${(lyStats.discovered || 0).toLocaleString()} discovered · ${lyStats.removed ? lyStats.removed + ' horizontals removed · ' : ''}target ${(lyStats.target || 100000).toLocaleString()}`;
        renderLastYearResults();
    }

    function bindLastYearEvents() {
        container.querySelectorAll('[data-ly-sort]').forEach(b => b.addEventListener('click', () => {
            lySort = b.dataset.lySort;
            container.querySelectorAll('[data-ly-sort]').forEach(x => x.classList.toggle('active', x.dataset.lySort === lySort));
            fetchLastYearVideos();
        }));
        container.querySelectorAll('[data-ly-kind]').forEach(b => b.addEventListener('click', () => {
            lyKind = b.dataset.lyKind;
            container.querySelectorAll('[data-ly-kind]').forEach(x => x.classList.toggle('active', x.dataset.lyKind === lyKind));
            lyVideos = []; fetchLastYearVideos();
        }));
        document.getElementById('ly-refresh-btn')?.addEventListener('click', () => fetchLastYearVideos());
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
        } else if (tab === 'lastyear') {
            content.innerHTML = renderLastYearTab();
            bindLastYearEvents();
            fetchLastYearVideos();
        } else {
            content.innerHTML = renderVaultTab();
            bindVaultEvents();
            // Fetch fresh data on tab open
            fetchVaultStats().then(() => updateVaultSubtitle());
            fetchVaultVideos(1);
        }
    }

    function updateVaultSubtitle() {
        const el = document.getElementById('vault-subtitle');
        if (el && vaultStats) {
            el.textContent = vaultSubtitleText();
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
            fetchVaultStats().then(() => updateVaultSubtitle());
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
            fetchVaultStats().then(() => updateVaultSubtitle());
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
