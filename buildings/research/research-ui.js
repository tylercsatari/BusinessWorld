/**
 * Research Facility UI — find viral YouTube videos, extract frames, analyze outliers.
 */
const ResearchUI = (() => {
    let container = null;
    let videos = [];
    let nextPageToken = null;
    let loading = false;
    let expandedId = null;
    let framesCache = {}; // videoId -> [frame filenames]
    let framesLoading = {}; // videoId -> boolean

    // Current search state
    let currentPreset = null;
    let currentMinViews = 10000000;
    let currentTimeRange = 'week';
    let currentQuery = '';

    const PRESETS = [
        { key: 'trending', label: 'Trending Now', trending: true },
        { key: '100m_week', label: '100M+ (Week)', minViews: 100000000, timeRange: 'week' },
        { key: '50m_week', label: '50M+ (Week)', minViews: 50000000, timeRange: 'week' },
        { key: '10m_24h', label: '10M+ (24h)', minViews: 10000000, timeRange: '24h' },
        { key: '10m_week', label: '10M+ (Week)', minViews: 10000000, timeRange: 'week' },
        { key: '5m_24h', label: '5M+ (24h)', minViews: 5000000, timeRange: '24h' },
        { key: '1m_month', label: '1M+ (Month)', minViews: 1000000, timeRange: 'month' },
        { key: '50m_month', label: '50M+ (Month)', minViews: 50000000, timeRange: 'month' },
        { key: '100m_year', label: '100M+ (Year)', minViews: 100000000, timeRange: 'year' },
    ];

    function formatViews(n) {
        if (n >= 1000000000) return (n / 1000000000).toFixed(1) + 'B';
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return String(n);
    }

    function formatDuration(iso) {
        if (!iso) return '';
        const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (!m) return '';
        const h = parseInt(m[1]) || 0;
        const min = parseInt(m[2]) || 0;
        const s = parseInt(m[3]) || 0;
        if (h > 0) return `${h}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${min}:${String(s).padStart(2, '0')}`;
    }

    function timeAgo(dateStr) {
        const diff = Date.now() - new Date(dateStr).getTime();
        const days = Math.floor(diff / 86400000);
        if (days < 1) return 'Today';
        if (days === 1) return '1 day ago';
        if (days < 7) return days + ' days ago';
        if (days < 30) return Math.floor(days / 7) + 'w ago';
        if (days < 365) return Math.floor(days / 30) + 'mo ago';
        return Math.floor(days / 365) + 'y ago';
    }

    function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function escAttr(s) { return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

    function render() {
        return `
        <div class="research-panel">
            <div class="research-header">
                <h2>Research Facility</h2>
                <div class="research-header-sub">Find viral outlier videos on YouTube</div>
            </div>
            <div class="research-presets" id="research-presets">
                ${PRESETS.map(p => `<button class="research-preset-btn${p.trending ? ' trending' : ''}${currentPreset === p.key ? ' active' : ''}" data-key="${p.key}">${p.label}</button>`).join('')}
            </div>
            <div class="research-custom">
                <label>Min Views</label>
                <input class="research-input" id="research-min-views" type="number" value="${currentMinViews}" placeholder="10000000" />
                <label>Time</label>
                <select class="research-select" id="research-time-range">
                    <option value="24h"${currentTimeRange === '24h' ? ' selected' : ''}>Last 24h</option>
                    <option value="3days"${currentTimeRange === '3days' ? ' selected' : ''}>Last 3 Days</option>
                    <option value="week"${currentTimeRange === 'week' ? ' selected' : ''}>Last Week</option>
                    <option value="month"${currentTimeRange === 'month' ? ' selected' : ''}>Last Month</option>
                    <option value="3months"${currentTimeRange === '3months' ? ' selected' : ''}>Last 3 Months</option>
                    <option value="year"${currentTimeRange === 'year' ? ' selected' : ''}>Last Year</option>
                </select>
                <label>Keyword</label>
                <input class="research-input" id="research-query" value="${escAttr(currentQuery)}" placeholder="Optional..." style="width:140px" />
                <button class="research-search-btn" id="research-search-btn">Search</button>
            </div>
            <div class="research-status" id="research-status" style="display:none">
                <span class="research-status-count" id="research-count"></span>
                <button class="research-load-more" id="research-load-more" style="display:none">Load More</button>
            </div>
            <div class="research-results" id="research-results" data-loaded="false">
                <div class="research-empty">Choose a preset or customize your search to find viral videos.</div>
            </div>
        </div>`;
    }

    function bindEvents() {
        // Preset clicks
        container.querySelectorAll('.research-preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.dataset.key;
                const preset = PRESETS.find(p => p.key === key);
                if (!preset) return;
                currentPreset = key;

                // Update active state
                container.querySelectorAll('.research-preset-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                if (preset.trending) {
                    fetchTrending();
                } else {
                    currentMinViews = preset.minViews;
                    currentTimeRange = preset.timeRange;
                    // Update inputs to reflect preset
                    const mvInput = document.getElementById('research-min-views');
                    const trSelect = document.getElementById('research-time-range');
                    if (mvInput) mvInput.value = currentMinViews;
                    if (trSelect) trSelect.value = currentTimeRange;
                    fetchViral();
                }
            });
        });

        // Custom search
        document.getElementById('research-search-btn')?.addEventListener('click', () => {
            currentPreset = null;
            container.querySelectorAll('.research-preset-btn').forEach(b => b.classList.remove('active'));
            currentMinViews = parseInt(document.getElementById('research-min-views')?.value) || 1000000;
            currentTimeRange = document.getElementById('research-time-range')?.value || 'week';
            currentQuery = (document.getElementById('research-query')?.value || '').trim();
            fetchViral();
        });

        // Enter key in inputs
        ['research-min-views', 'research-query'].forEach(id => {
            document.getElementById(id)?.addEventListener('keydown', e => {
                if (e.key === 'Enter') document.getElementById('research-search-btn')?.click();
            });
        });

        // Load more
        document.getElementById('research-load-more')?.addEventListener('click', () => {
            if (nextPageToken && !loading) fetchViral(true);
        });
    }

    async function fetchViral(append = false) {
        if (loading) return;
        loading = true;
        const results = document.getElementById('research-results');
        const status = document.getElementById('research-status');
        const btn = document.getElementById('research-search-btn');

        if (!append) {
            videos = [];
            nextPageToken = null;
            expandedId = null;
            if (results) results.innerHTML = '<div class="research-loading"><div class="spinner"></div><div style="margin-top:8px">Searching YouTube...</div></div>';
        }
        if (btn) btn.disabled = true;

        try {
            const params = new URLSearchParams({
                minViews: currentMinViews,
                timeRange: currentTimeRange,
                ...(currentQuery ? { query: currentQuery } : {}),
                ...(nextPageToken && append ? { pageToken: nextPageToken } : {})
            });
            const res = await fetch(`/api/research/viral?${params}`);
            const data = await res.json();

            if (!res.ok) throw new Error(data.error || 'Search failed');

            if (append) {
                videos = videos.concat(data.videos || []);
            } else {
                videos = data.videos || [];
            }
            nextPageToken = data.nextPageToken || null;
            renderResults();
        } catch (e) {
            if (results && !append) {
                const isAuth = e.message.includes('not configured') || e.message.includes('not connected') || e.message.includes('API key') || e.message.includes('expired') || e.message.includes('revoked') || e.message.includes('401');
                results.innerHTML = isAuth
                    ? `<div class="research-error">${escHtml(e.message)}<br><br><button class="research-search-btn" id="research-reconnect-yt">Reconnect YouTube</button><br><div style="color:#aaa;font-size:12px;margin-top:8px">Or add <code>YOUTUBE_API_KEY=your_key</code> to .env</div></div>`
                    : `<div class="research-error">${escHtml(e.message)}</div>`;
                document.getElementById('research-reconnect-yt')?.addEventListener('click', connectYouTube);
            }
        } finally {
            loading = false;
            if (btn) btn.disabled = false;
        }
    }

    async function fetchTrending() {
        if (loading) return;
        loading = true;
        const results = document.getElementById('research-results');
        const btn = document.getElementById('research-search-btn');
        videos = [];
        nextPageToken = null;
        expandedId = null;
        if (results) results.innerHTML = '<div class="research-loading"><div class="spinner"></div><div style="margin-top:8px">Fetching trending...</div></div>';
        if (btn) btn.disabled = true;

        try {
            const res = await fetch('/api/research/trending');
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed');
            videos = data.videos || [];
            renderResults();
        } catch (e) {
            if (results) {
                const isAuth = e.message.includes('not configured') || e.message.includes('not connected') || e.message.includes('API key') || e.message.includes('expired') || e.message.includes('revoked') || e.message.includes('401');
                results.innerHTML = isAuth
                    ? `<div class="research-error">${escHtml(e.message)}<br><br><button class="research-search-btn" id="research-reconnect-yt">Reconnect YouTube</button><br><div style="color:#aaa;font-size:12px;margin-top:8px">Or add <code>YOUTUBE_API_KEY=your_key</code> to .env</div></div>`
                    : `<div class="research-error">${escHtml(e.message)}</div>`;
                document.getElementById('research-reconnect-yt')?.addEventListener('click', connectYouTube);
            }
        } finally {
            loading = false;
            if (btn) btn.disabled = false;
        }
    }

    function renderResults() {
        const results = document.getElementById('research-results');
        const status = document.getElementById('research-status');
        const countEl = document.getElementById('research-count');
        const loadMore = document.getElementById('research-load-more');
        if (!results) return;

        if (status) status.style.display = videos.length > 0 ? '' : 'none';
        if (countEl) countEl.textContent = `${videos.length} video${videos.length !== 1 ? 's' : ''} found`;
        if (loadMore) loadMore.style.display = nextPageToken ? '' : 'none';

        if (videos.length === 0) {
            results.innerHTML = '<div class="research-empty">No videos found matching your criteria. Try lowering the view threshold or expanding the time range.</div>';
            return;
        }

        results.innerHTML = videos.map(v => {
            const isExpanded = expandedId === v.videoId;
            const frames = framesCache[v.videoId];
            const isFramesLoading = framesLoading[v.videoId];

            let detailHtml = '';
            if (isExpanded) {
                let framesHtml = '';
                if (isFramesLoading) {
                    framesHtml = '<div class="research-frames-loading"><div class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;vertical-align:middle"></div> Downloading frames...</div>';
                } else if (frames && frames.length > 0) {
                    framesHtml = `<div class="research-frames-strip">${frames.map(f =>
                        `<img src="/api/research/frame/${v.videoId}/${f}" alt="${f}" />`
                    ).join('')}</div>`;
                }

                detailHtml = `
                <div class="research-detail">
                    <div class="research-detail-actions">
                        <button class="research-detail-btn primary" data-action="grab-frames" data-vid="${escAttr(v.videoId)}"${frames ? ' disabled' : ''}>
                            ${frames ? 'Frames Downloaded' : 'Grab First Frames'}
                        </button>
                        <a href="https://www.youtube.com/watch?v=${escAttr(v.videoId)}" target="_blank" class="research-detail-btn">Open on YouTube</a>
                    </div>
                    ${framesHtml}
                </div>`;
            }

            return `
            <div class="research-video-card${isExpanded ? ' expanded' : ''}" data-vid="${escAttr(v.videoId)}">
                <div class="research-thumb">
                    <img src="${escAttr(v.thumbnail || '')}" alt="" loading="lazy" />
                    <span class="research-thumb-duration">${formatDuration(v.duration)}</span>
                </div>
                <div class="research-video-info">
                    <div class="research-video-title" title="${escAttr(v.title)}">${escHtml(v.title)}</div>
                    <div class="research-video-channel">${escHtml(v.channelTitle)} &middot; ${timeAgo(v.publishedAt)}</div>
                    <div class="research-video-stats">
                        <span class="research-stat"><span class="research-stat-value">${formatViews(v.views)}</span> <span class="research-stat-label">views</span></span>
                        <span class="research-stat"><span class="research-stat-value">${formatViews(v.likes)}</span> <span class="research-stat-label">likes</span></span>
                        <span class="research-stat"><span class="research-stat-value">${formatViews(v.comments)}</span> <span class="research-stat-label">comments</span></span>
                        ${v.views > 0 && v.likes > 0 ? `<span class="research-stat"><span class="research-stat-value">${(v.likes / v.views * 100).toFixed(2)}%</span> <span class="research-stat-label">like ratio</span></span>` : ''}
                    </div>
                    ${detailHtml}
                </div>
            </div>`;
        }).join('');

        // Bind card clicks (expand/collapse)
        results.querySelectorAll('.research-video-card').forEach(card => {
            card.addEventListener('click', (e) => {
                // Don't toggle if clicking a button or link
                if (e.target.closest('button') || e.target.closest('a')) return;
                const vid = card.dataset.vid;
                expandedId = expandedId === vid ? null : vid;
                renderResults();
            });
        });

        // Bind grab-frames buttons
        results.querySelectorAll('[data-action="grab-frames"]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                grabFrames(btn.dataset.vid);
            });
        });
    }

    async function grabFrames(videoId) {
        if (framesLoading[videoId] || framesCache[videoId]) return;
        framesLoading[videoId] = true;
        renderResults();

        try {
            const res = await fetch('/api/research/grab-frames', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videoId, seconds: 10 })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed');
            framesCache[videoId] = data.frames || [];
        } catch (e) {
            console.warn('Grab frames failed:', e.message);
        } finally {
            framesLoading[videoId] = false;
            renderResults();
        }
    }

    async function checkYouTubeStatus() {
        const results = document.getElementById('research-results');
        if (!results) return;
        try {
            // Use ?verify=true to actually test if the token works
            const res = await fetch('/api/youtube/status?verify=true');
            const data = await res.json();

            if (data.tokenWorks) {
                results.innerHTML = '<div class="research-empty">Choose a preset or customize your search to find viral videos.</div>';
                return;
            }

            // Token doesn't work — show reconnect UI
            const reason = data.isConnected
                ? 'Your YouTube OAuth token has expired. You need to reconnect.'
                : 'The Research Facility needs YouTube access to search for viral videos.';

            results.innerHTML = `<div class="research-error" style="text-align:left;max-width:500px;margin:30px auto">
                <div style="font-size:16px;font-weight:600;color:#fff;margin-bottom:12px">YouTube Connection Required</div>
                <div style="color:#aaa;font-size:13px;line-height:1.6;margin-bottom:16px">${reason}</div>
                <button class="research-search-btn" id="research-connect-yt" style="font-size:15px;padding:10px 24px">Connect YouTube</button>
                <div style="color:#666;font-size:11px;margin-top:12px">This opens Google's OAuth page. Approve access, then come back and search.</div>
            </div>`;
            document.getElementById('research-connect-yt')?.addEventListener('click', connectYouTube);
        } catch (e) {
            results.innerHTML = '<div class="research-empty">Choose a preset or customize your search to find viral videos.</div>';
        }
    }

    async function connectYouTube() {
        try {
            const res = await fetch('/api/youtube/auth-url');
            const data = await res.json();
            if (!data.url) { alert('Could not get YouTube auth URL. Check YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env.'); return; }

            // Open Google's OAuth page
            window.open(data.url, '_blank', 'width=500,height=600');

            const results = document.getElementById('research-results');
            if (!results) return;

            // Show waiting state and poll for connection
            results.innerHTML = `<div class="research-loading">
                <div class="spinner"></div>
                <div style="margin-top:8px">Waiting for YouTube authorization...</div>
                <div style="color:#666;font-size:12px;margin-top:12px">Complete the login in the popup.</div>
                <div id="research-code-fallback" style="display:none;margin-top:20px;text-align:left;max-width:500px;background:#111;padding:14px;border-radius:8px">
                    <div style="color:#aaa;font-size:13px;line-height:1.8;margin-bottom:10px">
                        If the popup redirected to a page that won't load, copy the full URL from the popup's address bar and paste it below:
                    </div>
                    <div style="display:flex;gap:8px">
                        <input class="research-input" id="research-auth-code" placeholder="Paste the URL or code here..." style="flex:1;width:auto" />
                        <button class="research-search-btn" id="research-submit-code">Submit</button>
                    </div>
                    <div id="research-code-status" style="margin-top:8px;font-size:12px;color:#888"></div>
                </div>
            </div>`;

            // Poll for successful connection (the callback may have worked automatically)
            let pollCount = 0;
            const pollInterval = setInterval(async () => {
                pollCount++;
                try {
                    const statusRes = await fetch('/api/youtube/status?verify=true');
                    const statusData = await statusRes.json();
                    if (statusData.tokenWorks) {
                        clearInterval(pollInterval);
                        results.innerHTML = '<div class="research-empty" style="color:#27ae60;font-weight:600">YouTube connected! Choose a preset or search to find viral videos.</div>';
                        return;
                    }
                } catch (e) {}
                // After 8 seconds, show the manual code paste fallback
                if (pollCount >= 4) {
                    const fallback = document.getElementById('research-code-fallback');
                    if (fallback) fallback.style.display = '';
                    document.getElementById('research-submit-code')?.addEventListener('click', submitAuthCode);
                    document.getElementById('research-auth-code')?.addEventListener('keydown', e => {
                        if (e.key === 'Enter') submitAuthCode();
                    });
                }
                // Stop polling after 60 seconds
                if (pollCount >= 30) clearInterval(pollInterval);
            }, 2000);
        } catch (e) {
            alert('Error: ' + e.message);
        }
    }

    async function submitAuthCode() {
        const input = document.getElementById('research-auth-code');
        const status = document.getElementById('research-code-status');
        if (!input || !status) return;

        // Extract just the code from the full URL or raw code
        let code = input.value.trim();
        const codeMatch = code.match(/[?&]code=([^&]+)/);
        if (codeMatch) code = decodeURIComponent(codeMatch[1]);
        if (!code) { status.textContent = 'Please paste the code from the URL bar.'; status.style.color = '#e74c3c'; return; }

        status.textContent = 'Exchanging code...';
        status.style.color = '#888';

        try {
            const res = await fetch('/api/youtube/exchange-code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed');

            status.textContent = 'YouTube connected! Try a search now.';
            status.style.color = '#27ae60';

            // Re-check status after a moment
            setTimeout(() => checkYouTubeStatus(), 1000);
        } catch (e) {
            status.textContent = 'Error: ' + e.message;
            status.style.color = '#e74c3c';
        }
    }

    return {
        open(bodyEl) {
            container = bodyEl;
            container.innerHTML = render();
            bindEvents();
            checkYouTubeStatus();
        },
        close() {
            container = null;
            videos = [];
            nextPageToken = null;
            expandedId = null;
            framesCache = {};
            framesLoading = {};
            loading = false;
        }
    };
})();

BuildingRegistry.register('Science Center', {
    open: (bodyEl, opts) => ResearchUI.open(bodyEl, opts),
    close: () => ResearchUI.close()
});
