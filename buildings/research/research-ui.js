/**
 * Research Facility UI — find viral YouTube videos sorted by popularity.
 * Fetches once per time+type combo, caches results, filters views client-side.
 */
const ResearchUI = (() => {
    let container = null;
    let cachedVideos = []; // full unfiltered result set
    let loading = false;
    let expandedId = null;
    let framesCache = {};
    let framesLoading = {};

    let currentTime = 'week';
    let currentType = 'all';
    let currentMinViews = 0;
    let cacheKey = ''; // tracks what's cached to avoid redundant fetches

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
        { key: 0, label: 'Any Views' },
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
                <div class="research-header-sub">Most popular YouTube videos by time period</div>
            </div>
            <div class="research-presets" id="research-time-btns">
                ${TIME_OPTIONS.map(t => `<button class="research-preset-btn${currentTime === t.key ? ' active' : ''}" data-time="${t.key}">${t.label}</button>`).join('')}
            </div>
            <div class="research-presets" id="research-type-btns" style="border-top:none;padding-top:0">
                ${TYPE_OPTIONS.map(t => `<button class="research-preset-btn${t.key === 'shorts' ? ' trending' : ''}${currentType === t.key ? ' active' : ''}" data-type="${t.key}">${t.label}</button>`).join('')}
                <span style="width:1px;background:#333;margin:0 4px"></span>
                ${VIEW_OPTIONS.map(v => `<button class="research-preset-btn${currentMinViews === v.key ? ' active' : ''}" data-views="${v.key}">${v.label}</button>`).join('')}
            </div>
            <div class="research-status" id="research-status" style="display:none">
                <span class="research-status-count" id="research-count"></span>
            </div>
            <div class="research-results" id="research-results">
                <div class="research-empty">Loading...</div>
            </div>
        </div>`;
    }

    function bindEvents() {
        container.querySelectorAll('#research-time-btns .research-preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                currentTime = btn.dataset.time;
                container.querySelectorAll('#research-time-btns .research-preset-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                fetchVideos(); // time changed = new fetch
            });
        });
        container.querySelectorAll('#research-type-btns .research-preset-btn[data-type]').forEach(btn => {
            btn.addEventListener('click', () => {
                currentType = btn.dataset.type;
                container.querySelectorAll('#research-type-btns [data-type]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                fetchVideos(); // type changed = new fetch
            });
        });
        container.querySelectorAll('#research-type-btns .research-preset-btn[data-views]').forEach(btn => {
            btn.addEventListener('click', () => {
                currentMinViews = parseInt(btn.dataset.views) || 0;
                container.querySelectorAll('#research-type-btns [data-views]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                renderResults(); // views changed = just re-filter cached data, no new fetch
            });
        });
    }

    async function fetchVideos(retryCount = 0) {
        const key = `${currentTime}_${currentType}`;
        if (key === cacheKey && cachedVideos.length > 0) {
            renderResults(); // already have this data
            return;
        }
        if (loading) return;
        loading = true;
        expandedId = null;
        const results = document.getElementById('research-results');
        if (results) results.innerHTML = '<div class="research-loading"><div class="spinner"></div><div style="margin-top:8px">Finding popular videos...</div></div>';

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 50000);
            const res = await fetch(`/api/research/popular?timeRange=${currentTime}&type=${currentType}`, { signal: controller.signal });
            clearTimeout(timeout);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Search failed');
            cachedVideos = data.videos || [];
            cacheKey = key;
            if (cachedVideos.length === 0 && retryCount === 0) {
                loading = false;
                if (results) results.innerHTML = '<div class="research-loading"><div class="spinner"></div><div style="margin-top:8px">Retrying...</div></div>';
                return fetchVideos(1);
            }
            renderResults();
        } catch (e) {
            if (retryCount === 0) {
                loading = false;
                if (results) results.innerHTML = '<div class="research-loading"><div class="spinner"></div><div style="margin-top:8px">Retrying...</div></div>';
                return fetchVideos(1);
            }
            if (results) results.innerHTML = `<div class="research-error">${escHtml(e.message)}<br><br><button class="research-search-btn" onclick="ResearchUI._retry()">Retry</button></div>`;
        } finally {
            loading = false;
        }
    }

    function renderResults() {
        const results = document.getElementById('research-results');
        const status = document.getElementById('research-status');
        const countEl = document.getElementById('research-count');
        if (!results) return;

        // Filter cached videos by min views (client-side, instant)
        const filtered = currentMinViews > 0
            ? cachedVideos.filter(v => v.views >= currentMinViews)
            : cachedVideos;

        if (status) status.style.display = filtered.length > 0 ? '' : 'none';
        if (countEl) countEl.textContent = `${filtered.length} video${filtered.length !== 1 ? 's' : ''} found`;

        if (filtered.length === 0) {
            const total = cachedVideos.length;
            const topView = total > 0 ? formatViews(cachedVideos[0].views) : '0';
            results.innerHTML = total > 0
                ? `<div class="research-empty">No videos over ${formatViews(currentMinViews)} views. ${total} videos loaded, highest is ${topView}. Try a lower threshold.</div>`
                : '<div class="research-empty">No videos found. Try a different time period or type.</div>';
            return;
        }

        results.innerHTML = filtered.map(v => {
            const isExpanded = expandedId === v.videoId;
            const frames = framesCache[v.videoId];
            const isFramesLoading = framesLoading[v.videoId];
            let detailHtml = '';
            if (isExpanded) {
                let framesHtml = '';
                if (isFramesLoading) {
                    framesHtml = '<div class="research-frames-loading"><div class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;vertical-align:middle"></div> Downloading frames...</div>';
                } else if (frames && frames.length > 0) {
                    framesHtml = `<div class="research-frames-strip">${frames.map(f => `<img src="/api/research/frame/${v.videoId}/${f}" alt="${f}" />`).join('')}</div>`;
                }
                detailHtml = `<div class="research-detail">
                    <div class="research-detail-actions">
                        <button class="research-detail-btn primary" data-action="grab-frames" data-vid="${escAttr(v.videoId)}"${frames ? ' disabled' : ''}>${frames ? 'Frames Downloaded' : 'Grab First Frames'}</button>
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
            fetchVideos();
        },
        _retry() { cacheKey = ''; fetchVideos(); },
        close() {
            container = null; cachedVideos = []; cacheKey = '';
            expandedId = null; framesCache = {}; framesLoading = {}; loading = false;
        }
    };
})();

BuildingRegistry.register('Science Center', {
    open: (bodyEl, opts) => ResearchUI.open(bodyEl, opts),
    close: () => ResearchUI.close()
});
