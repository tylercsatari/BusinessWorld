/**
 * Research Facility UI — find viral YouTube videos sorted by popularity.
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

    function render() {
        return `
        <div class="research-panel">
            <div class="research-header">
                <h2>Research Facility</h2>
                <div class="research-header-sub">Most popular YouTube videos</div>
            </div>
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

    function bindEvents() {
        // Time buttons — set state only
        container.querySelectorAll('#research-time-btns .research-preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                currentTime = btn.dataset.time;
                container.querySelectorAll('#research-time-btns .research-preset-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                cachedVideos = []; // clear cache so next Search re-fetches
            });
        });
        // Type buttons — set state only
        container.querySelectorAll('#research-type-btns .research-preset-btn[data-type]').forEach(btn => {
            btn.addEventListener('click', () => {
                currentType = btn.dataset.type;
                container.querySelectorAll('#research-type-btns [data-type]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                cachedVideos = []; // clear cache so next Search re-fetches
                // Update DB status bar visibility
                fetchShortsDbStats();
            });
        });
        // View threshold — instant client-side filter, no re-fetch needed
        container.querySelectorAll('#research-type-btns .research-preset-btn[data-views]').forEach(btn => {
            btn.addEventListener('click', () => {
                currentMinViews = parseInt(btn.dataset.views) || 0;
                container.querySelectorAll('#research-type-btns [data-views]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (cachedVideos.length > 0) renderResults();
                else doSearch();
            });
        });
        // Search button — always fetches fresh
        document.getElementById('research-go-btn')?.addEventListener('click', () => { cachedVideos = []; doSearch(); });
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
            container.innerHTML = render();
            bindEvents();
            // Fetch shorts DB stats on open
            fetchShortsDbStats();
        },
        _retry() { doSearch(); },
        close() {
            container = null; cachedVideos = []; expandedId = null;
            framesCache = {}; framesLoading = {}; loading = false;
            shortsDbCache = {};
        }
    };
})();

BuildingRegistry.register('Science Center', {
    open: (bodyEl, opts) => ResearchUI.open(bodyEl, opts),
    close: () => ResearchUI.close()
});
