/**
 * Pen UI — Posted videos gallery.
 * Each posted video shows a 3D egg (same as Incubator/Workshop).
 * Panel shows all posted videos, filterable by project.
 * Can import old/backlog videos or analyze YouTube URLs.
 */
const PenUI = (() => {
    let container = null;
    let projects = [];
    let filterProject = '';
    let selectedVideo = null;
    let currentPage = 'list';
    let showImportRow = false;
    let analysisData = null;   // cached analysis for current detail view
    let activeTab = 'general';
    let pollTimer = null;
    let listPollTimer = null;
    let expandedFrameIdx = null;
    let visibleCount = 50; // pagination: how many cards to show
    let sortMetric = 'date'; // 'date' | 'views' | 'likes' | 'comments' | 'revenue' | 'shares' | 'subsGained' | 'avgRetention' | 'avgPercentViewed' | 'engagementRate'
    let metricsCache = null; // { videoId: { views, likes, ... } }
    let metricsFetching = false;

    const escHtml = HtmlUtils.escHtml;
    const escAttr = HtmlUtils.escAttr;
    const USD_TO_CAD = 1.36;

    const SORT_OPTIONS = [
        { key: 'date', label: 'Date Posted' },
        { key: 'views', label: 'Views' },
        { key: 'likes', label: 'Likes' },
        { key: 'comments', label: 'Comments' },
        { key: 'revenue', label: 'Revenue' },
        { key: 'shares', label: 'Shares' },
        { key: 'subsGained', label: 'Subs Gained' },
        { key: 'avgRetention', label: 'Avg Retention' },
        { key: 'avgPercentViewed', label: 'Avg % Viewed' },
        { key: 'engagementRate', label: 'Engagement Rate' }
    ];

    async function fetchMetricsSummary() {
        if (metricsCache) return metricsCache;
        if (metricsFetching) return null;
        metricsFetching = true;
        try {
            const res = await fetch('/api/video/metrics-summary');
            if (!res.ok) throw new Error('Metrics fetch failed');
            metricsCache = await res.json();
            return metricsCache;
        } catch (e) {
            console.warn('Pen: metrics summary fetch failed', e);
            return null;
        } finally {
            metricsFetching = false;
        }
    }

    function getMetricValue(videoId, metric) {
        if (!metricsCache || !metricsCache[videoId]) return 0;
        return metricsCache[videoId][metric] || 0;
    }

    function update3DCreatureScales() {
        if (typeof updatePenCreatureScales !== 'function') return;
        if (sortMetric === 'date' || !metricsCache) {
            updatePenCreatureScales(null); // reset to default
            return;
        }
        const posted = VideoService.getByStatus('posted');
        const values = posted.map(v => getMetricValue(v.id, sortMetric));
        const maxVal = Math.max(...values, 0.001);
        const scaleMap = {};
        posted.forEach((v, i) => {
            const ratio = values[i] / maxVal;
            // 3D scale range: 0.4 (smallest) to 1.8 (largest)
            scaleMap[v.id] = 0.4 + ratio * 1.4;
        });
        updatePenCreatureScales(scaleMap);
    }

    function formatMetricValue(value, metric) {
        if (metric === 'revenue') return 'C$' + (value * USD_TO_CAD).toFixed(2);
        if (metric === 'avgRetention') return (value * 100).toFixed(1) + '%';
        if (metric === 'avgPercentViewed') return value.toFixed(1) + '%';
        if (metric === 'engagementRate') return (value * 100).toFixed(1) + '%';
        return formatNumber(value);
    }

    // Detect if a name is still a raw YouTube video ID (11 chars, base64url)
    function looksLikeYouTubeId(name) {
        return name && /^[\w-]{11}$/.test(name.trim());
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function formatDuration(sec) {
        if (!sec) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function formatNumber(n) {
        if (n == null) return '—';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return n.toLocaleString();
    }

    // Cache rendered creature snapshots — keyed by "project|ghost"
    const _creatureCache = new Map();

    function renderCardCreatures() {
        if (!window.EggRenderer) return;
        const canvases = container.querySelectorAll('.pen-creature-canvas');
        if (canvases.length === 0) return;

        // Group canvases by cache key to minimize renders
        const groups = new Map();
        canvases.forEach(canvas => {
            const proj = canvas.dataset.project;
            const ghost = canvas.dataset.ghost === 'true';
            const key = `${proj}|${ghost}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(canvas);
        });

        for (const [key, targets] of groups) {
            // Check cache first
            if (_creatureCache.has(key)) {
                const cached = _creatureCache.get(key);
                for (const canvas of targets) {
                    canvas.width = cached.width;
                    canvas.height = cached.height;
                    canvas.getContext('2d').drawImage(cached, 0, 0);
                }
                continue;
            }

            // Render once to first canvas, then cache and copy
            const [proj, ghostStr] = key.split('|');
            const ghost = ghostStr === 'true';
            const first = targets[0];
            window.EggRenderer.renderCreatureSnapshot(proj, first, 44, ghost ? { ghost: true } : undefined);

            // Cache the rendered result as an offscreen canvas
            const cacheCanvas = document.createElement('canvas');
            cacheCanvas.width = first.width;
            cacheCanvas.height = first.height;
            cacheCanvas.getContext('2d').drawImage(first, 0, 0);
            _creatureCache.set(key, cacheCanvas);

            // Copy to remaining canvases
            for (let i = 1; i < targets.length; i++) {
                targets[i].width = cacheCanvas.width;
                targets[i].height = cacheCanvas.height;
                targets[i].getContext('2d').drawImage(cacheCanvas, 0, 0);
            }
        }
    }

    // ============ RENDER ============

    function render() {
        container.innerHTML = `
            <div class="pen-panel show-list">
                <div class="pen-page pen-list-page">
                    <div class="pen-header">
                        <h2>The Pen</h2>
                        <div class="pen-header-actions">
                            <button class="pen-import-btn" id="pen-import-btn">+ Import Video</button>
                            <div class="pen-dropdown-wrap" id="pen-tools-wrap">
                                <button class="pen-import-btn pen-tools-btn" id="pen-tools-btn">Tools &#9662;</button>
                                <div class="pen-dropdown" id="pen-tools-menu">
                                    <button class="pen-dropdown-item" id="pen-fetch-all-analytics">Fetch All Analytics</button>
                                    <button class="pen-dropdown-item" id="pen-reanalyze-all-frames">Fix Frames</button>
                                    <button class="pen-dropdown-item" id="pen-reupload-dropbox">Re-upload Missing to Dropbox</button>
                                    <button class="pen-dropdown-item" id="pen-download-hd">Download All HD Videos</button>
                                    <hr style="border:none;border-top:1px solid #333;margin:4px 0;">
                                    <button class="pen-dropdown-item" id="pen-fill-all-missing" style="color:#00b894;font-weight:600;">Fill All Missing Data</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div id="pen-import-area"></div>
                    <div id="pen-batch-analytics-area"></div>
                    <div class="pen-filters" id="pen-filters"></div>
                    <div class="pen-videos" id="pen-videos">
                        ${Array(4).fill(`<div class="pen-skeleton-card">
                            <div class="pen-skeleton-creature"></div>
                            <div class="pen-skeleton-lines">
                                <div class="pen-skeleton-line"></div>
                                <div class="pen-skeleton-line short"></div>
                            </div>
                        </div>`).join('')}
                    </div>
                </div>
                <div class="pen-page pen-detail-page">
                    <div class="pen-detail" id="pen-detail"></div>
                </div>
            </div>
        `;
        document.getElementById('pen-import-btn').addEventListener('click', toggleImportRow);
        // Tools dropdown toggle
        const toolsBtn = document.getElementById('pen-tools-btn');
        const toolsMenu = document.getElementById('pen-tools-menu');
        toolsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toolsMenu.classList.toggle('open');
        });
        document.addEventListener('click', () => toolsMenu.classList.remove('open'), { once: false });
        // Dropdown items
        document.getElementById('pen-fetch-all-analytics').addEventListener('click', () => { toolsMenu.classList.remove('open'); handleBatchAnalytics(); });
        document.getElementById('pen-reanalyze-all-frames').addEventListener('click', () => { toolsMenu.classList.remove('open'); handleBatchReanalyzeFrames(); });
        document.getElementById('pen-reupload-dropbox').addEventListener('click', () => { toolsMenu.classList.remove('open'); handleBatchReuploadDropbox(); });
        document.getElementById('pen-download-hd').addEventListener('click', () => { toolsMenu.classList.remove('open'); handleBatchDownloadHD(); });
        document.getElementById('pen-fill-all-missing').addEventListener('click', () => { toolsMenu.classList.remove('open'); handleFillAllMissing(); });
    }

    function toggleImportRow() {
        showImportRow = !showImportRow;
        renderImportArea();
    }

    function parseYouTubeUrls(text) {
        // Extract YouTube video IDs from text containing URLs (one per line, comma, or space separated)
        const urlPattern = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/g;
        const ids = [];
        let match;
        while ((match = urlPattern.exec(text)) !== null) {
            if (!ids.includes(match[1])) ids.push(match[1]);
        }
        return ids;
    }

    function parseChannelUrl(text) {
        const m = text.trim().match(/(?:https?:\/\/)?(?:www\.)?youtube\.com\/((?:@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+))/i);
        return m ? `https://www.youtube.com/${m[1]}` : null;
    }

    function renderImportArea() {
        const el = document.getElementById('pen-import-area');
        if (!el) return;
        if (!showImportRow) { el.innerHTML = ''; return; }
        el.innerHTML = `
            <div class="pen-import-row pen-import-multi">
                <textarea id="pen-import-url" placeholder="Paste YouTube URLs or a channel URL (e.g. youtube.com/@handle)..." rows="3"></textarea>
                <div class="pen-import-actions">
                    <button id="pen-analyze-btn">Analyze</button>
                    <button class="pen-import-cancel" id="pen-import-cancel">Cancel</button>
                </div>
            </div>
        `;
        const textarea = document.getElementById('pen-import-url');
        const btn = document.getElementById('pen-analyze-btn');
        textarea.focus();

        function updateBtnLabel() {
            if (parseChannelUrl(textarea.value)) {
                btn.textContent = 'Discover Shorts';
                return;
            }
            const count = parseYouTubeUrls(textarea.value).length;
            btn.textContent = count > 1 ? `Analyze ${count} videos` : 'Analyze';
        }
        textarea.addEventListener('input', updateBtnLabel);

        btn.addEventListener('click', handleAnalyzeUrl);
        document.getElementById('pen-import-cancel').addEventListener('click', () => { showImportRow = false; renderImportArea(); });
        textarea.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAnalyzeUrl();
            if (e.key === 'Escape') { showImportRow = false; renderImportArea(); }
        });
    }

    async function handleChannelDiscover(channelUrl) {
        const el = document.getElementById('pen-import-area');
        if (!el) return;
        el.innerHTML = `
            <div class="pen-batch-progress">
                <div class="pen-batch-header">
                    <span><span class="pen-batch-spinner"></span> Discovering Shorts...</span>
                </div>
            </div>
        `;
        try {
            const result = await VideoService.discoverChannelShorts(channelUrl);
            if (result.error) throw new Error(result.error);
            if (result.newIds.length === 0) {
                el.innerHTML = `
                    <div class="pen-batch-progress">
                        <div class="pen-batch-header"><span>All ${result.total} Shorts already analyzed</span></div>
                        <button id="pen-discover-ok" class="pen-batch-done-btn">OK</button>
                    </div>
                `;
                document.getElementById('pen-discover-ok').addEventListener('click', () => { showImportRow = false; renderImportArea(); });
            } else {
                el.innerHTML = `
                    <div class="pen-batch-progress">
                        <div class="pen-batch-header">
                            <span>Found ${result.total} total, ${result.alreadyAnalyzed} already analyzed.</span>
                        </div>
                        <div class="pen-batch-header"><strong>${result.newIds.length} new Shorts</strong> ready to analyze.</div>
                        <div class="pen-import-actions" style="margin-top:8px;">
                            <button id="pen-discover-go">Analyze ${result.newIds.length} videos</button>
                            <button class="pen-import-cancel" id="pen-discover-cancel">Cancel</button>
                        </div>
                    </div>
                `;
                document.getElementById('pen-discover-go').addEventListener('click', () => {
                    const textarea = document.getElementById('pen-import-url') || document.createElement('textarea');
                    // Rebuild the import area with video URLs, then trigger batch analyze
                    showImportRow = true;
                    renderImportArea();
                    const ta = document.getElementById('pen-import-url');
                    if (ta) {
                        ta.value = result.newIds.map(id => `https://youtube.com/shorts/${id}`).join('\n');
                        handleAnalyzeUrl();
                    }
                });
                document.getElementById('pen-discover-cancel').addEventListener('click', () => { showImportRow = false; renderImportArea(); });
            }
        } catch (e) {
            el.innerHTML = `
                <div class="pen-batch-progress">
                    <div class="pen-batch-header"><span>Discovery failed: ${escHtml(e.message)}</span></div>
                    <button id="pen-discover-ok" class="pen-batch-done-btn">OK</button>
                </div>
            `;
            document.getElementById('pen-discover-ok').addEventListener('click', () => { showImportRow = false; renderImportArea(); });
        }
    }

    async function handleAnalyzeUrl() {
        const textarea = document.getElementById('pen-import-url');
        const text = (textarea ? textarea.value : '').trim();
        if (!text) return;

        // Check for channel URL first
        const channelUrl = parseChannelUrl(text);
        if (channelUrl) { handleChannelDiscover(channelUrl); return; }

        const ytIds = parseYouTubeUrls(text);
        if (ytIds.length === 0) { alert('No valid YouTube URLs found.'); return; }

        // Single video — use original quick flow
        if (ytIds.length === 1) {
            const btn = document.getElementById('pen-analyze-btn');
            btn.disabled = true;
            btn.textContent = 'Starting...';
            try {
                const result = await VideoService.startVideoAnalysis(`https://youtube.com/watch?v=${ytIds[0]}`);
                if (result.error) { alert(result.error); btn.disabled = false; btn.textContent = 'Analyze'; return; }
                const ytId = result.jobId;
                let title = 'Analyzing...';
                try {
                    const status = await VideoService.getAnalysisStatus(ytId);
                    if (status && status.title) title = status.title;
                } catch (e) {}
                const video = await VideoService.create({
                    name: title, status: 'posted', youtubeVideoId: ytId,
                    analysisStatus: 'analyzing', postedDate: new Date().toISOString().slice(0, 10)
                });
                showImportRow = false;
                openDetail(video.id);
            } catch (e) {
                console.warn('Pen: analyze failed', e);
                alert('Failed to start analysis: ' + (e.message || e));
                btn.disabled = false;
                btn.textContent = 'Analyze';
            }
            return;
        }

        // Multi-video batch flow
        const el = document.getElementById('pen-import-area');
        if (!el) return;

        // Build batch progress panel — kick off all analyses, then poll all concurrently
        const jobs = ytIds.map(id => ({ ytId: id, status: 'queued', title: id, videoId: null, progress: 0, statusLabel: '' }));

        function renderBatchProgress() {
            el.innerHTML = `
                <div class="pen-batch-progress">
                    <div class="pen-batch-header">
                        <span>Analyzing ${jobs.length} videos</span>
                        <span class="pen-batch-count">${jobs.filter(j => j.status === 'complete').length}/${jobs.length} done</span>
                    </div>
                    <div class="pen-batch-list">
                        ${jobs.map((j, i) => `
                            <div class="pen-batch-item pen-batch-${j.status}" data-idx="${i}">
                                <div class="pen-batch-item-header">
                                    <span class="pen-batch-icon">${j.status === 'complete' ? '&#10003;' : j.status === 'error' ? '&#10007;' : j.status === 'analyzing' ? '<span class="pen-batch-spinner"></span>' : '&#9679;'}</span>
                                    <span class="pen-batch-title">${escHtml(j.title)}</span>
                                    ${j.status === 'complete' && j.videoId ? '<span class="pen-batch-open">View</span>' : ''}
                                    ${j.status === 'error' ? '<span class="pen-batch-error-label">Failed</span>' : ''}
                                    ${j.status === 'analyzing' ? `<span class="pen-batch-pct">${j.progress}%</span>` : ''}
                                </div>
                                ${j.status === 'analyzing' ? `
                                    <div class="pen-batch-bar-wrap">
                                        <div class="pen-batch-bar" style="width:${j.progress}%"></div>
                                    </div>
                                    ${j.statusLabel ? `<div class="pen-batch-status-label">${escHtml(j.statusLabel)}</div>` : ''}
                                ` : ''}
                            </div>
                        `).join('')}
                    </div>
                    ${jobs.every(j => j.status === 'complete' || j.status === 'error') ? `
                        <button id="pen-batch-done" class="pen-batch-done-btn">Done</button>
                    ` : ''}
                </div>
            `;
            el.querySelectorAll('.pen-batch-item').forEach(item => {
                const idx = parseInt(item.dataset.idx);
                const job = jobs[idx];
                if (job.status === 'complete' && job.videoId) {
                    item.style.cursor = 'pointer';
                    item.addEventListener('click', () => { showImportRow = false; openDetail(job.videoId); });
                }
            });
            const doneBtn = document.getElementById('pen-batch-done');
            if (doneBtn) doneBtn.addEventListener('click', () => { showImportRow = false; renderImportArea(); renderFilters(); renderVideos(); });
        }

        renderBatchProgress();

        // Start all analyses, then poll all concurrently
        // First, kick off each analysis and create records
        for (const job of jobs) {
            job.status = 'analyzing';
            job.statusLabel = 'Starting...';
            renderBatchProgress();
            try {
                const result = await VideoService.startVideoAnalysis(`https://youtube.com/watch?v=${job.ytId}`);
                if (result.error) { job.status = 'error'; renderBatchProgress(); continue; }
                const ytId = result.jobId;
                job.ytId = ytId; // update to canonical ID
                let title = job.ytId;
                try {
                    const s = await VideoService.getAnalysisStatus(ytId);
                    if (s && s.title) title = s.title;
                } catch (e) {}
                job.title = title;
                job.statusLabel = 'Queued';

                const video = await VideoService.create({
                    name: title, status: 'posted', youtubeVideoId: ytId,
                    analysisStatus: 'analyzing', postedDate: new Date().toISOString().slice(0, 10)
                });
                job.videoId = video.id;
                renderBatchProgress();
            } catch (e) {
                console.warn('Batch analyze failed for', job.ytId, e);
                job.status = 'error';
                renderBatchProgress();
            }
        }

        // Now poll all analyzing jobs concurrently
        const activeJobs = jobs.filter(j => j.status === 'analyzing');
        if (activeJobs.length > 0) {
            const batchPoll = setInterval(async () => {
                for (const job of activeJobs) {
                    if (job.status !== 'analyzing') continue;
                    try {
                        const s = await VideoService.getAnalysisStatus(job.ytId);
                        if (!s) continue;
                        if (s.title && s.title !== job.title) job.title = s.title;
                        job.progress = s.progress || 0;
                        job.statusLabel = (s.status || 'queued').replace(/_/g, ' ');

                        if (s.status === 'complete') {
                            job.status = 'complete';
                            job.progress = 100;
                            const updates = { analysisStatus: 'complete', name: job.title };
                            try {
                                const analysis = await VideoService.getVideoAnalysis(job.ytId);
                                if (analysis?.metadata?.uploadDate) {
                                    updates.postedDate = analysis.metadata.uploadDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
                                }
                                if (analysis?.metadata?.title && looksLikeYouTubeId(updates.name)) {
                                    updates.name = analysis.metadata.title;
                                    job.title = analysis.metadata.title;
                                }
                            } catch (e) {}
                            await VideoService.update(job.videoId, updates);
                        } else if (s.status === 'error') {
                            job.status = 'error';
                            await VideoService.update(job.videoId, { analysisStatus: 'error' });
                        }
                    } catch (e) { console.warn('Batch poll error:', e); }
                }
                renderBatchProgress();
                // Stop polling when all done
                if (activeJobs.every(j => j.status !== 'analyzing')) {
                    clearInterval(batchPoll);
                    renderFilters();
                    renderVideos();
                }
            }, 2500);
        }
    }

    function renderFilters() {
        const el = document.getElementById('pen-filters');
        if (!el) return;
        const posted = VideoService.getByStatus('posted');
        const usedProjects = [...new Set(posted.map(v => v.project).filter(Boolean))].sort();

        el.innerHTML = `
            <div class="pen-filter-row">
                <div class="pen-project-filters">
                    <button class="pen-filter-btn ${!filterProject ? 'active' : ''}" data-project="">All (${posted.length})</button>
                    ${usedProjects.map(p => {
                        const count = posted.filter(v => v.project === p).length;
                        return `<button class="pen-filter-btn ${filterProject === p ? 'active' : ''}" data-project="${escAttr(p)}">${escHtml(p)} (${count})</button>`;
                    }).join('')}
                </div>
                <div class="pen-sort-wrap">
                    <select class="pen-sort-select" id="pen-sort-select">
                        ${SORT_OPTIONS.map(o => `<option value="${o.key}" ${sortMetric === o.key ? 'selected' : ''}>${o.label}</option>`).join('')}
                    </select>
                </div>
            </div>
        `;

        el.querySelectorAll('.pen-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                filterProject = btn.dataset.project;
                visibleCount = 50;
                renderFilters();
                renderVideos();
            });
        });

        document.getElementById('pen-sort-select').addEventListener('change', async (e) => {
            sortMetric = e.target.value;
            if (sortMetric !== 'date' && !metricsCache) {
                // Show loading state
                const el = document.getElementById('pen-videos');
                if (el) el.style.opacity = '0.4';
                await fetchMetricsSummary();
                if (el) el.style.opacity = '';
            }
            visibleCount = 50;
            renderVideos();
            // Update 3D creature scales in the pen world
            update3DCreatureScales();
        });
    }

    function renderVideos() {
        const el = document.getElementById('pen-videos');
        if (!el) return;
        let posted = VideoService.getByStatus('posted');
        if (filterProject) posted = posted.filter(v => v.project === filterProject);

        // Sort by selected metric
        if (sortMetric === 'date') {
            posted.sort((a, b) => (b.postedDate || '').localeCompare(a.postedDate || ''));
        } else if (metricsCache) {
            posted.sort((a, b) => getMetricValue(b.id, sortMetric) - getMetricValue(a.id, sortMetric));
        }

        if (posted.length === 0) {
            el.innerHTML = '<div class="pen-empty">No posted videos yet. Hatch eggs from the Workshop!</div>';
            return;
        }

        const visible = posted.slice(0, visibleCount);
        const hasMore = posted.length > visibleCount;

        el.innerHTML = visible.map(v => {
            const isBacklog = !v.hook && !v.context && v.links;
            const projBadge = window.EggRenderer ? window.EggRenderer.projectBadgeHtml(v.project) : escHtml(v.project || 'No project');
            const isAnalyzing = v.analysisStatus === 'analyzing';
            const noProject = !v.project;
            const metricHtml = (sortMetric !== 'date' && metricsCache) ? `<span class="pen-metric-badge">${formatMetricValue(getMetricValue(v.id, sortMetric), sortMetric)}</span>` : '';
            return `
            <div class="pen-video-card ${isBacklog ? 'backlog' : ''} ${noProject ? 'pen-no-project' : ''}" data-id="${v.id}">
                <div class="pen-video-badge">
                    <canvas class="pen-creature-canvas" data-project="${escAttr(v.project || v.name)}" data-ghost="${!v.project}" width="88" height="88"></canvas>
                </div>
                <div class="pen-video-info">
                    <div class="pen-video-name">${escHtml(v.name)}${metricHtml}</div>
                    <div class="pen-video-meta">
                        <span class="pen-video-project">${projBadge}</span>
                        ${v.postedDate ? `<span class="pen-video-date">${formatDate(v.postedDate)}</span>` : ''}
                    </div>
                    ${isAnalyzing ? `
                        <div class="pen-card-progress" data-ytid="${escAttr(v.youtubeVideoId || '')}">
                            <div class="pen-card-progress-bar-wrap">
                                <div class="pen-card-progress-bar" style="width:0%"></div>
                            </div>
                            <span class="pen-card-progress-label">Analyzing...</span>
                        </div>
                    ` : ''}
                </div>
            </div>`;
        }).join('') + (hasMore ? `
            <button class="pen-load-more" id="pen-load-more">Show more (${posted.length - visibleCount} remaining)</button>
        ` : '');

        el.querySelectorAll('.pen-video-card').forEach(card => {
            card.addEventListener('click', () => openDetail(card.dataset.id));
        });

        const loadMoreBtn = document.getElementById('pen-load-more');
        if (loadMoreBtn) {
            loadMoreBtn.addEventListener('click', () => {
                visibleCount += 50;
                renderVideos();
            });
        }

        // Render 3D creatures after DOM is ready
        requestAnimationFrame(() => renderCardCreatures());

        // Start list-level polling for any analyzing videos
        startListPolling();
    }

    function stopListPolling() {
        if (listPollTimer) { clearInterval(listPollTimer); listPollTimer = null; }
    }

    function startListPolling() {
        stopListPolling();
        const analyzingVideos = VideoService.getByStatus('posted').filter(v => v.analysisStatus === 'analyzing' && v.youtubeVideoId);
        if (analyzingVideos.length === 0) return;

        async function pollList() {
            if (currentPage !== 'list') { stopListPolling(); return; }
            let anyChanged = false;
            for (const v of analyzingVideos) {
                try {
                    const s = await VideoService.getAnalysisStatus(v.youtubeVideoId);
                    if (!s) continue;

                    // Update progress bar on the card
                    const progressEl = document.querySelector(`.pen-card-progress[data-ytid="${v.youtubeVideoId}"]`);
                    if (progressEl) {
                        const bar = progressEl.querySelector('.pen-card-progress-bar');
                        const label = progressEl.querySelector('.pen-card-progress-label');
                        if (bar) bar.style.width = (s.progress || 0) + '%';
                        if (label) label.textContent = `${(s.status || 'analyzing').replace(/_/g, ' ')} ${s.progress || 0}%`;
                    }

                    // Update title if changed
                    if (s.title && s.title !== v.name) {
                        v.name = s.title;
                        const nameEl = document.querySelector(`.pen-video-card[data-id="${v.id}"] .pen-video-name`);
                        if (nameEl) nameEl.textContent = s.title;
                    }

                    if (s.status === 'complete') {
                        const updates = { analysisStatus: 'complete', name: s.title || v.name };
                        try {
                            const analysis = await VideoService.getVideoAnalysis(v.youtubeVideoId);
                            if (analysis?.metadata?.uploadDate) {
                                updates.postedDate = analysis.metadata.uploadDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
                            }
                            if (analysis?.metadata?.title && looksLikeYouTubeId(updates.name)) {
                                updates.name = analysis.metadata.title;
                            }
                        } catch (e) {}
                        await VideoService.update(v.id, updates);
                        v.analysisStatus = 'complete';
                        anyChanged = true;
                    } else if (s.status === 'error') {
                        await VideoService.update(v.id, { analysisStatus: 'error' });
                        v.analysisStatus = 'error';
                        anyChanged = true;
                    }
                } catch (e) { /* ignore poll errors */ }
            }

            // If any finished, re-render the list to remove progress bars
            if (anyChanged) {
                renderFilters();
                renderVideos();
            }

            // Stop if none left analyzing
            if (analyzingVideos.every(v => v.analysisStatus !== 'analyzing')) {
                stopListPolling();
            }
        }

        pollList();
        listPollTimer = setInterval(pollList, 3000);
    }

    function openDetail(id) {
        stopListPolling();
        selectedVideo = VideoService.getById(id);
        if (!selectedVideo) return;
        currentPage = 'detail';
        activeTab = 'general';
        analysisData = null;
        expandedFrameIdx = null;
        const panel = container.querySelector('.pen-panel');
        panel.classList.remove('show-list');
        panel.classList.add('show-detail');
        renderDetail();
    }

    function showList() {
        stopPolling();
        currentPage = 'list';
        selectedVideo = null;
        analysisData = null;
        const panel = container.querySelector('.pen-panel');
        panel.classList.remove('show-detail');
        panel.classList.add('show-list');
        renderFilters();
        renderVideos();
    }

    // ============ DETAIL VIEW ============

    function renderDetail() {
        const el = document.getElementById('pen-detail');
        if (!el || !selectedVideo) return;
        renderAnalysisDetail(el, selectedVideo);
    }

    // ============ ANALYSIS DETAIL VIEW ============

    function renderAnalysisDetail(el, v) {
        el.innerHTML = `
            <div class="pen-detail-toolbar">
                <button class="pen-back-btn" id="pen-back-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    Back
                </button>
                <button class="pen-delete-btn" id="pen-delete-btn">Delete</button>
            </div>
            <div id="pen-analysis-content" style="flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0;"></div>
        `;

        document.getElementById('pen-back-btn').addEventListener('click', () => saveAndBack());
        document.getElementById('pen-delete-btn').addEventListener('click', () => handleDelete());

        // No youtubeVideoId — just show General tab (no analysis to load)
        if (!v.youtubeVideoId) {
            renderAnalysisTabs();
            return;
        }

        // Check analysis status — show tabs first, then load/poll
        if (v.analysisStatus === 'analyzing') {
            renderAnalysisTabs();
            startPolling(v.youtubeVideoId);
            return;
        }

        // Try loading analysis data
        if (!analysisData) {
            renderAnalysisTabs(); // show General tab immediately while loading
            loadAnalysis(v.youtubeVideoId);
        } else {
            renderAnalysisTabs();
        }
    }

    async function loadAnalysis(ytId) {
        try {
            analysisData = await VideoService.getVideoAnalysis(ytId);
            if (!analysisData) {
                // Maybe it's still running — check status
                const status = await VideoService.getAnalysisStatus(ytId);
                if (status && !['complete', 'error'].includes(status.status)) {
                    if (selectedVideo) {
                        selectedVideo.analysisStatus = 'analyzing';
                        startPolling(ytId);
                    }
                }
                return;
            }
            // Update postedDate from actual YouTube upload date if still set to import date
            if (selectedVideo && analysisData.metadata?.uploadDate) {
                const uploadDate = analysisData.metadata.uploadDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
                if (uploadDate !== selectedVideo.postedDate) {
                    await VideoService.update(selectedVideo.id, { postedDate: uploadDate });
                    selectedVideo = VideoService.getById(selectedVideo.id);
                }
            }
            // Update name from metadata if it's still a raw YouTube ID
            if (selectedVideo && analysisData.metadata?.title && looksLikeYouTubeId(selectedVideo.name)) {
                await VideoService.update(selectedVideo.id, { name: analysisData.metadata.title });
                selectedVideo = VideoService.getById(selectedVideo.id);
            }
            // Re-render tabs now that analysis data is available
            renderAnalysisTabs();
        } catch (e) {
            const tabContentEl = document.getElementById('pen-tab-content');
            if (tabContentEl && activeTab !== 'general') {
                tabContentEl.innerHTML = `<div style="text-align:center;padding:40px;color:#e74c3c;">Failed to load analysis: ${escHtml(e.message)}</div>`;
            }
        }
    }

    // ============ PROGRESS POLLING ============

    function startPolling(ytId) {
        function renderProgress(status) {
            // Show progress in the tab content area (below tabs)
            const tabContentEl = document.getElementById('pen-tab-content');
            if (!tabContentEl || activeTab === 'general') return;
            const pct = status.progress || 0;
            const label = (status.status || 'queued').replace(/_/g, ' ');
            tabContentEl.innerHTML = `
                <div class="pen-progress">
                    <div class="pen-progress-pct">${pct}%</div>
                    <div class="pen-progress-bar-wrap">
                        <div class="pen-progress-bar" style="width:${pct}%"></div>
                    </div>
                    <div class="pen-progress-label">${escHtml(label)}</div>
                    ${status.title ? `<div style="margin-top:12px;font-size:16px;font-weight:700;color:#333;">${escHtml(status.title)}</div>` : ''}
                </div>
            `;
        }

        renderProgress({ status: 'queued', progress: 0 });

        async function poll() {
            try {
                const status = await VideoService.getAnalysisStatus(ytId);
                if (!status) return;
                renderProgress(status);

                if (status.status === 'complete') {
                    stopPolling();
                    // Update video record
                    if (selectedVideo) {
                        const title = status.title || selectedVideo.name;
                        await VideoService.update(selectedVideo.id, { analysisStatus: 'complete', name: title });
                        selectedVideo = VideoService.getById(selectedVideo.id);
                    }
                    // Load analysis
                    await loadAnalysis(ytId);
                    // Auto-fetch YouTube analytics if connected
                    await autoFetchAnalytics(ytId);
                } else if (status.status === 'error') {
                    stopPolling();
                    if (selectedVideo) {
                        await VideoService.update(selectedVideo.id, { analysisStatus: 'error' });
                    }
                    const tabContentEl = document.getElementById('pen-tab-content');
                    if (tabContentEl) {
                        tabContentEl.innerHTML = `<div style="text-align:center;padding:40px;color:#e74c3c;">Analysis failed: ${escHtml(status.error || 'Unknown error')}</div>`;
                    }
                }
            } catch (e) {
                console.warn('Poll failed:', e);
            }
        }

        poll();
        pollTimer = setInterval(poll, 2000);
    }

    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    // Auto-fetch YouTube analytics if connected (called after analysis completes)
    async function autoFetchAnalytics(ytId) {
        try {
            const statusRes = await fetch('/api/youtube/status');
            const ytStatus = await statusRes.json();
            if (!ytStatus.isConnected) return;

            console.log('Pen: Auto-fetching YouTube analytics for', ytId);
            const res = await fetch(`/api/youtube/analytics/${ytId}`);
            const data = await res.json();
            if (data.error) { console.warn('Auto-fetch analytics failed:', data.error); return; }

            // Merge analytics into cached analysis data
            if (analysisData) {
                analysisData.analytics = data;
                // Update metadata with fresh counts from analytics
                if (data.likes != null) analysisData.metadata.likeCount = data.likes;
                if (data.comments != null) analysisData.metadata.commentCount = data.comments;
                if (data.totalViews != null) analysisData.metadata.viewCount = data.totalViews;
                // Re-render current tab to show updated data
                renderTabContent();
            }
        } catch (e) {
            console.warn('Pen: Auto-fetch analytics error:', e);
        }
    }

    // Batch fetch analytics for all videos missing them
    let _batchAnalyticsCancelled = false;

    async function handleBatchAnalytics() {
        // Check YouTube connection first
        const statusRes = await fetch('/api/youtube/status');
        const ytStatus = await statusRes.json();
        if (!ytStatus.isConnected) {
            alert('Connect your YouTube account first (open any video → Analytics tab).');
            return;
        }

        // Find videos missing analytics (fast server-side check)
        const btn = document.getElementById('pen-fetch-all-analytics');
        btn.disabled = true;
        btn.textContent = 'Checking...';

        let missingRes;
        try {
            const r = await fetch('/api/youtube/analytics-missing');
            missingRes = await r.json();
        } catch (e) {
            alert('Failed to check: ' + e.message);
            btn.disabled = false;
            btn.textContent = 'Fetch All Analytics';
            return;
        }

        const needsAnalytics = (missingRes.missing || []).map(m => ({ video: { name: m.name }, ytId: m.ytId }));

        if (needsAnalytics.length === 0) {
            alert(`All ${missingRes.total} videos already have analytics data!`);
            btn.disabled = false;
            btn.textContent = 'Fetch All Analytics';
            return;
        }

        _batchAnalyticsCancelled = false;
        const el = document.getElementById('pen-batch-analytics-area');
        btn.textContent = 'Fetching...';

        let done = 0, failed = 0;

        function renderProgress(currentName) {
            el.innerHTML = `
                <div class="pen-batch-progress">
                    <div class="pen-batch-header">
                        <span>Fetching analytics: ${done + failed}/${needsAnalytics.length}</span>
                        <span class="pen-batch-count">${done} done, ${failed} failed</span>
                    </div>
                    <div class="pen-batch-bar-wrap">
                        <div class="pen-batch-bar" style="width:${((done + failed) / needsAnalytics.length * 100).toFixed(0)}%"></div>
                    </div>
                    <div style="font-size:12px;color:#888;margin-top:4px;">${escHtml(currentName || '')}</div>
                    <button id="pen-batch-analytics-cancel" class="pen-import-cancel" style="margin-top:8px;">Cancel</button>
                </div>
            `;
            document.getElementById('pen-batch-analytics-cancel')?.addEventListener('click', () => {
                _batchAnalyticsCancelled = true;
            });
        }

        renderProgress('Starting...');

        const errors = [];
        for (const item of needsAnalytics) {
            if (_batchAnalyticsCancelled) break;
            renderProgress(item.video.name);
            try {
                const res = await fetch(`/api/youtube/analytics/${item.ytId}`);
                const data = await res.json();
                if (data.error) { failed++; errors.push(`${item.video.name}: ${data.error}`); }
                else { done++; }
            } catch (e) { failed++; errors.push(`${item.video.name}: ${e.message}`); }
        }

        el.innerHTML = `
            <div class="pen-batch-progress">
                <div class="pen-batch-header">
                    <span>${_batchAnalyticsCancelled ? 'Cancelled' : 'Done'}: ${done} fetched, ${failed} failed</span>
                </div>
                ${errors.length > 0 ? `<div class="pen-batch-errors">${errors.map(e => `<div class="pen-batch-error-line">${escHtml(e)}</div>`).join('')}</div>` : ''}
                <button id="pen-batch-analytics-done" class="pen-batch-done-btn" style="margin-top:8px;">OK</button>
            </div>
        `;
        document.getElementById('pen-batch-analytics-done')?.addEventListener('click', () => {
            el.innerHTML = '';
        });
        btn.disabled = false;
        btn.textContent = 'Fetch All Analytics';
    }

    // Batch reanalyze frames for all videos with missing/failed frame analyses
    let _batchFramesCancelled = false;

    async function handleBatchReanalyzeFrames() {
        const btn = document.getElementById('pen-reanalyze-all-frames');
        btn.disabled = true;
        btn.textContent = 'Checking...';

        let data;
        try {
            const r = await fetch('/api/video/incomplete-frames');
            data = await r.json();
        } catch (e) {
            alert('Failed to check: ' + e.message);
            btn.disabled = false;
            btn.textContent = 'Fix Frames';
            return;
        }

        const incomplete = data.incomplete || [];
        if (incomplete.length === 0) {
            alert(`All ${data.total} videos have complete frame analysis!`);
            btn.disabled = false;
            btn.textContent = 'Fix Frames';
            return;
        }

        const totalMissing = incomplete.reduce((s, v) => s + v.missingFrames, 0);
        if (!confirm(`Found ${incomplete.length} videos with ${totalMissing} missing frames. Start reanalysis?`)) {
            btn.disabled = false;
            btn.textContent = 'Fix Frames';
            return;
        }

        _batchFramesCancelled = false;
        const el = document.getElementById('pen-batch-analytics-area');
        btn.textContent = 'Processing...';

        let done = 0, failed = 0;

        function renderProgress(currentName, currentStatus) {
            el.innerHTML = `
                <div class="pen-batch-progress">
                    <div class="pen-batch-header">
                        <span>Reanalyzing frames: ${done + failed}/${incomplete.length} videos</span>
                        <span class="pen-batch-count">${done} done, ${failed} failed</span>
                    </div>
                    <div class="pen-batch-bar-wrap">
                        <div class="pen-batch-bar" style="width:${((done + failed) / incomplete.length * 100).toFixed(0)}%"></div>
                    </div>
                    <div style="font-size:12px;color:#888;margin-top:4px;">${escHtml(currentName || '')} ${currentStatus ? '— ' + escHtml(currentStatus) : ''}</div>
                    <button id="pen-batch-frames-cancel" class="pen-import-cancel" style="margin-top:8px;">Cancel</button>
                </div>
            `;
            document.getElementById('pen-batch-frames-cancel')?.addEventListener('click', () => {
                _batchFramesCancelled = true;
            });
        }

        renderProgress('Starting...');

        const errors = [];
        for (const item of incomplete) {
            if (_batchFramesCancelled) break;
            renderProgress(item.name, `${item.missingFrames} frames`);

            try {
                // Kick off reanalysis
                const startRes = await fetch('/api/video/reanalyze-frames', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ videoId: item.ytId })
                });
                const startData = await startRes.json();
                if (startData.error) { failed++; errors.push(`${item.name}: ${startData.error}`); continue; }

                // Poll until complete
                let status = 'analyzing_frames';
                let lastError = null;
                while (status === 'analyzing_frames' && !_batchFramesCancelled) {
                    await new Promise(r => setTimeout(r, 3000));
                    const pollRes = await fetch(`/api/video/status/${item.ytId}`);
                    const pollData = await pollRes.json();
                    status = pollData.status;
                    lastError = pollData.error;
                    renderProgress(item.name, `${pollData.progress || 0}%`);
                }

                if (status === 'complete') done++;
                else if (status === 'error') { failed++; errors.push(`${item.name}: ${lastError || 'Unknown error'}`); }
                else done++;
            } catch (e) {
                failed++;
                errors.push(`${item.name}: ${e.message}`);
            }
        }

        el.innerHTML = `
            <div class="pen-batch-progress">
                <div class="pen-batch-header">
                    <span>${_batchFramesCancelled ? 'Cancelled' : 'Done'}: ${done} reanalyzed, ${failed} failed</span>
                </div>
                ${errors.length > 0 ? `<div class="pen-batch-errors">${errors.map(e => `<div class="pen-batch-error-line">${escHtml(e)}</div>`).join('')}</div>` : ''}
                <button id="pen-batch-frames-done" class="pen-batch-done-btn" style="margin-top:8px;">OK</button>
            </div>
        `;
        document.getElementById('pen-batch-frames-done')?.addEventListener('click', () => {
            el.innerHTML = '';
        });
        btn.disabled = false;
        btn.textContent = 'Fix Frames';
    }

    // Batch re-upload missing videos to Dropbox
    let _batchReuploadCancelled = false;

    async function handleBatchReuploadDropbox() {
        const el = document.getElementById('pen-batch-analytics-area');
        el.innerHTML = `<div class="pen-batch-progress"><div class="pen-batch-header"><span>Checking for missing Dropbox uploads...</span></div></div>`;

        let data;
        try {
            const r = await fetch('/api/video/missing-dropbox');
            data = await r.json();
        } catch (e) {
            el.innerHTML = `<div class="pen-batch-progress"><div class="pen-batch-header"><span>Failed: ${escHtml(e.message)}</span></div><button class="pen-batch-done-btn" onclick="this.closest('.pen-batch-progress').parentElement.innerHTML=''">OK</button></div>`;
            return;
        }

        const missing = data.missing || [];
        if (missing.length === 0) {
            el.innerHTML = `<div class="pen-batch-progress"><div class="pen-batch-header"><span>All ${data.total} videos already uploaded to Dropbox!</span></div><button id="pen-reupload-done" class="pen-batch-done-btn" style="margin-top:8px;">OK</button></div>`;
            document.getElementById('pen-reupload-done')?.addEventListener('click', () => { el.innerHTML = ''; });
            return;
        }

        if (!confirm(`Found ${missing.length} videos missing from Dropbox. Start re-upload?`)) {
            el.innerHTML = '';
            return;
        }

        _batchReuploadCancelled = false;
        let done = 0, failed = 0;

        function renderProgress(currentName) {
            el.innerHTML = `
                <div class="pen-batch-progress">
                    <div class="pen-batch-header">
                        <span>Re-uploading to Dropbox: ${done + failed}/${missing.length}</span>
                        <span class="pen-batch-count">${done} done, ${failed} failed</span>
                    </div>
                    <div class="pen-batch-bar-wrap">
                        <div class="pen-batch-bar" style="width:${((done + failed) / missing.length * 100).toFixed(0)}%"></div>
                    </div>
                    <div style="font-size:12px;color:#888;margin-top:4px;">${escHtml(currentName || '')}</div>
                    <button id="pen-batch-reupload-cancel" class="pen-import-cancel" style="margin-top:8px;">Cancel</button>
                </div>
            `;
            document.getElementById('pen-batch-reupload-cancel')?.addEventListener('click', () => { _batchReuploadCancelled = true; });
        }

        renderProgress('Starting...');
        const errors = [];
        for (const item of missing) {
            if (_batchReuploadCancelled) break;
            renderProgress(item.name);
            try {
                const res = await fetch('/api/video/reupload-dropbox', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ videoId: item.ytId })
                });
                const result = await res.json();
                if (result.error) { failed++; errors.push(`${item.name}: ${result.error}`); }
                else done++;
            } catch (e) { failed++; errors.push(`${item.name}: ${e.message}`); }
        }

        el.innerHTML = `
            <div class="pen-batch-progress">
                <div class="pen-batch-header">
                    <span>${_batchReuploadCancelled ? 'Cancelled' : 'Done'}: ${done} uploaded, ${failed} failed</span>
                </div>
                ${errors.length > 0 ? `<div class="pen-batch-errors">${errors.map(e => `<div class="pen-batch-error-line">${escHtml(e)}</div>`).join('')}</div>` : ''}
                <button id="pen-batch-reupload-done" class="pen-batch-done-btn" style="margin-top:8px;">OK</button>
            </div>
        `;
        document.getElementById('pen-batch-reupload-done')?.addEventListener('click', () => { el.innerHTML = ''; });
    }

    // Batch download HD videos to Dropbox
    let _batchHDCancelled = false;

    async function handleBatchDownloadHD() {
        const el = document.getElementById('pen-batch-analytics-area');
        el.innerHTML = `<div class="pen-batch-progress"><div class="pen-batch-header"><span>Checking for missing HD videos...</span></div></div>`;

        let data;
        try {
            const r = await fetch('/api/video/missing-hd');
            data = await r.json();
        } catch (e) {
            el.innerHTML = `<div class="pen-batch-progress"><div class="pen-batch-header"><span>Failed: ${escHtml(e.message)}</span></div><button class="pen-batch-done-btn" onclick="this.closest('.pen-batch-progress').parentElement.innerHTML=''">OK</button></div>`;
            return;
        }

        const missing = data.missing || [];
        if (missing.length === 0) {
            el.innerHTML = `<div class="pen-batch-progress"><div class="pen-batch-header"><span>All ${data.total} videos already have HD versions!</span></div><button id="pen-hd-done" class="pen-batch-done-btn" style="margin-top:8px;">OK</button></div>`;
            document.getElementById('pen-hd-done')?.addEventListener('click', () => { el.innerHTML = ''; });
            return;
        }

        if (!confirm(`Found ${missing.length} videos missing HD versions. Start HD download & upload?`)) {
            el.innerHTML = '';
            return;
        }

        _batchHDCancelled = false;
        let done = 0, failed = 0;

        function renderProgress(currentName) {
            el.innerHTML = `
                <div class="pen-batch-progress">
                    <div class="pen-batch-header">
                        <span>Downloading HD: ${done + failed}/${missing.length}</span>
                        <span class="pen-batch-count">${done} done, ${failed} failed</span>
                    </div>
                    <div class="pen-batch-bar-wrap">
                        <div class="pen-batch-bar" style="width:${((done + failed) / missing.length * 100).toFixed(0)}%"></div>
                    </div>
                    <div style="font-size:12px;color:#888;margin-top:4px;">${escHtml(currentName || '')}</div>
                    <button id="pen-batch-hd-cancel" class="pen-import-cancel" style="margin-top:8px;">Cancel</button>
                </div>
            `;
            document.getElementById('pen-batch-hd-cancel')?.addEventListener('click', () => { _batchHDCancelled = true; });
        }

        renderProgress('Starting...');
        const errors = [];
        for (const item of missing) {
            if (_batchHDCancelled) break;
            renderProgress(item.name);
            try {
                const res = await fetch('/api/video/download-hd', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ videoId: item.ytId })
                });
                const result = await res.json();
                if (result.error) { failed++; errors.push(`${item.name}: ${result.error}`); }
                else done++;
            } catch (e) { failed++; errors.push(`${item.name}: ${e.message}`); }
        }

        el.innerHTML = `
            <div class="pen-batch-progress">
                <div class="pen-batch-header">
                    <span>${_batchHDCancelled ? 'Cancelled' : 'Done'}: ${done} downloaded, ${failed} failed</span>
                </div>
                ${errors.length > 0 ? `<div class="pen-batch-errors">${errors.map(e => `<div class="pen-batch-error-line">${escHtml(e)}</div>`).join('')}</div>` : ''}
                <button id="pen-batch-hd-done" class="pen-batch-done-btn" style="margin-top:8px;">OK</button>
            </div>
        `;
        document.getElementById('pen-batch-hd-done')?.addEventListener('click', () => { el.innerHTML = ''; });
    }

    // ============ FILL ALL MISSING DATA ============
    let _fillAllCancelled = false;

    async function handleFillAllMissing() {
        _fillAllCancelled = false;
        const el = document.getElementById('pen-batch-analytics-area');
        const results = { transcripts: 0, dropbox: 0, hd: 0, frames: 0, analytics: 0, failures: 0 };
        const errors = [];

        function renderFillProgress(phase, current, total, itemName) {
            const phasePct = total > 0 ? ((current / total) * 100).toFixed(0) : 0;
            el.innerHTML = `
                <div class="pen-batch-progress">
                    <div class="pen-batch-header">
                        <span>${escHtml(phase)}</span>
                        <span class="pen-batch-count">${current}/${total}</span>
                    </div>
                    <div class="pen-batch-bar-wrap">
                        <div class="pen-batch-bar" style="width:${phasePct}%"></div>
                    </div>
                    <div style="font-size:12px;color:#888;margin-top:4px;">${escHtml(itemName || '')}</div>
                    <div style="font-size:11px;color:#666;margin-top:6px;">
                        Transcripts: ${results.transcripts} | Dropbox: ${results.dropbox} | HD: ${results.hd} | Frames: ${results.frames} | Analytics: ${results.analytics}${results.failures ? ' | Failed: ' + results.failures : ''}
                    </div>
                    <button id="pen-fill-all-cancel" class="pen-import-cancel" style="margin-top:8px;">Cancel</button>
                </div>
            `;
            document.getElementById('pen-fill-all-cancel')?.addEventListener('click', () => { _fillAllCancelled = true; });
        }

        // Phase 1: Dropbox uploads
        renderFillProgress('Checking Dropbox uploads...', 0, 0, '');
        try {
            const r = await fetch('/api/video/missing-dropbox');
            const data = await r.json();
            const missing = data.missing || [];
            if (missing.length > 0 && !_fillAllCancelled) {
                for (let i = 0; i < missing.length && !_fillAllCancelled; i++) {
                    renderFillProgress('Uploading to Dropbox', i, missing.length, missing[i].name);
                    try {
                        const res = await fetch('/api/video/reupload-dropbox', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ videoId: missing[i].ytId })
                        });
                        const result = await res.json();
                        if (result.error) { results.failures++; errors.push(`Dropbox: ${missing[i].name}: ${result.error}`); }
                        else results.dropbox++;
                    } catch (e) { results.failures++; errors.push(`Dropbox: ${missing[i].name}: ${e.message}`); }
                }
            }
        } catch (e) { errors.push(`Dropbox check failed: ${e.message}`); }

        // Phase 2: Transcripts
        if (!_fillAllCancelled) {
            renderFillProgress('Checking transcripts...', 0, 0, '');
            try {
                const r = await fetch('/api/video/missing-transcripts');
                const data = await r.json();
                const missing = data.missing || [];
                if (missing.length > 0) {
                    for (let i = 0; i < missing.length && !_fillAllCancelled; i++) {
                        renderFillProgress('Fetching transcripts', i, missing.length, missing[i].name);
                        try {
                            const res = await fetch('/api/video/refetch-transcript', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ videoId: missing[i].ytId })
                            });
                            const result = await res.json();
                            if (result.error) { results.failures++; errors.push(`Transcript: ${missing[i].name}: ${result.error}`); }
                            else results.transcripts++;
                        } catch (e) { results.failures++; errors.push(`Transcript: ${missing[i].name}: ${e.message}`); }
                    }
                }
            } catch (e) { errors.push(`Transcript check failed: ${e.message}`); }
        }

        // Phase 3: HD downloads
        if (!_fillAllCancelled) {
            renderFillProgress('Checking HD downloads...', 0, 0, '');
            try {
                const r = await fetch('/api/video/missing-hd');
                const data = await r.json();
                const missing = data.missing || [];
                if (missing.length > 0) {
                    for (let i = 0; i < missing.length && !_fillAllCancelled; i++) {
                        renderFillProgress('Downloading HD', i, missing.length, missing[i].name);
                        try {
                            const res = await fetch('/api/video/download-hd', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ videoId: missing[i].ytId })
                            });
                            const result = await res.json();
                            if (result.error) { results.failures++; errors.push(`HD: ${missing[i].name}: ${result.error}`); }
                            else results.hd++;
                        } catch (e) { results.failures++; errors.push(`HD: ${missing[i].name}: ${e.message}`); }
                    }
                }
            } catch (e) { errors.push(`HD check failed: ${e.message}`); }
        }

        // Phase 4: Frame analyses
        if (!_fillAllCancelled) {
            renderFillProgress('Checking frame analyses...', 0, 0, '');
            try {
                const r = await fetch('/api/video/incomplete-frames');
                const data = await r.json();
                const incomplete = data.incomplete || [];
                if (incomplete.length > 0) {
                    for (let i = 0; i < incomplete.length && !_fillAllCancelled; i++) {
                        renderFillProgress('Analyzing frames', i, incomplete.length, incomplete[i].name);
                        try {
                            const startRes = await fetch('/api/video/reanalyze-frames', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ videoId: incomplete[i].ytId })
                            });
                            const startData = await startRes.json();
                            if (startData.error) { results.failures++; errors.push(`Frames: ${incomplete[i].name}: ${startData.error}`); continue; }

                            // Poll until complete
                            let status = 'analyzing_frames';
                            let lastError = null;
                            while (status === 'analyzing_frames' && !_fillAllCancelled) {
                                await new Promise(r => setTimeout(r, 3000));
                                const pollRes = await fetch(`/api/video/status/${incomplete[i].ytId}`);
                                const pollData = await pollRes.json();
                                status = pollData.status;
                                lastError = pollData.error;
                                renderFillProgress('Analyzing frames', i, incomplete.length, `${incomplete[i].name} — ${pollData.progress || 0}%`);
                            }

                            if (status === 'complete') results.frames++;
                            else if (status === 'error') { results.failures++; errors.push(`Frames: ${incomplete[i].name}: ${lastError || 'Unknown error'}`); }
                            else results.frames++;
                        } catch (e) { results.failures++; errors.push(`Frames: ${incomplete[i].name}: ${e.message}`); }
                    }
                }
            } catch (e) { errors.push(`Frames check failed: ${e.message}`); }
        }

        // Phase 5: YouTube analytics
        if (!_fillAllCancelled) {
            renderFillProgress('Checking YouTube analytics...', 0, 0, '');
            try {
                const statusRes = await fetch('/api/youtube/status');
                const ytStatus = await statusRes.json();
                if (ytStatus.isConnected) {
                    const r = await fetch('/api/youtube/analytics-missing');
                    const missingRes = await r.json();
                    const needsAnalytics = missingRes.missing || [];
                    if (needsAnalytics.length > 0) {
                        for (let i = 0; i < needsAnalytics.length && !_fillAllCancelled; i++) {
                            renderFillProgress('Fetching analytics', i, needsAnalytics.length, needsAnalytics[i].name);
                            try {
                                const res = await fetch(`/api/youtube/analytics/${needsAnalytics[i].ytId}`);
                                const data = await res.json();
                                if (data.error) { results.failures++; errors.push(`Analytics: ${needsAnalytics[i].name}: ${data.error}`); }
                                else results.analytics++;
                            } catch (e) { results.failures++; errors.push(`Analytics: ${needsAnalytics[i].name}: ${e.message}`); }
                        }
                    }
                }
            } catch (e) { errors.push(`Analytics check failed: ${e.message}`); }
        }

        // Final summary
        const total = results.transcripts + results.dropbox + results.hd + results.frames + results.analytics;
        const summaryParts = [];
        if (results.transcripts) summaryParts.push(`${results.transcripts} transcripts`);
        if (results.dropbox) summaryParts.push(`${results.dropbox} Dropbox`);
        if (results.hd) summaryParts.push(`${results.hd} HD`);
        if (results.frames) summaryParts.push(`${results.frames} frames`);
        if (results.analytics) summaryParts.push(`${results.analytics} analytics`);
        const summaryText = _fillAllCancelled ? 'Cancelled' : 'Done';
        const detailText = total === 0 && results.failures === 0
            ? 'Nothing to fill — all data is complete!'
            : `${summaryParts.join(', ') || 'No items processed'}${results.failures ? '. ' + results.failures + ' failed.' : '.'}`;

        el.innerHTML = `
            <div class="pen-batch-progress">
                <div class="pen-batch-header">
                    <span>${summaryText}: ${detailText}</span>
                </div>
                ${errors.length > 0 ? `<div class="pen-batch-errors">${errors.map(e => `<div class="pen-batch-error-line">${escHtml(e)}</div>`).join('')}</div>` : ''}
                <button id="pen-fill-all-done" class="pen-batch-done-btn" style="margin-top:8px;">OK</button>
            </div>
        `;
        document.getElementById('pen-fill-all-done')?.addEventListener('click', () => { el.innerHTML = ''; });
    }

    // ============ TABBED ANALYSIS VIEW ============

    function renderAnalysisTabs() {
        const contentEl = document.getElementById('pen-analysis-content');
        if (!contentEl || !selectedVideo) return;

        const hasYt = !!selectedVideo.youtubeVideoId;
        const tabs = ['General', ...(hasYt ? ['Video', 'Overview', 'Transcript', 'Frames', 'Analytics'] : [])];
        contentEl.innerHTML = `
            <div class="pen-tabs">
                ${tabs.map(t => `<button class="pen-tab-btn ${activeTab === t.toLowerCase() ? 'active' : ''}" data-tab="${t.toLowerCase()}">${t}</button>`).join('')}
            </div>
            <div class="pen-tab-content" id="pen-tab-content"></div>
        `;

        contentEl.querySelectorAll('.pen-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                activeTab = btn.dataset.tab;
                contentEl.querySelectorAll('.pen-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab));
                renderTabContent();
            });
        });

        renderTabContent();
    }

    function renderTabContent() {
        const el = document.getElementById('pen-tab-content');
        if (!el) return;

        if (activeTab === 'general') {
            renderGeneralTab(el);
            return;
        }
        if (!analysisData) {
            const isAnalyzing = selectedVideo && selectedVideo.analysisStatus === 'analyzing';
            if (!isAnalyzing) {
                el.innerHTML = '<div style="text-align:center;padding:40px;color:#888;">Loading analysis...</div>';
            }
            return;
        }
        switch (activeTab) {
            case 'video': renderVideoTab(el); break;
            case 'overview': renderOverviewTab(el); break;
            case 'transcript': renderTranscriptTab(el); break;
            case 'frames': renderFramesTab(el); break;
            case 'analytics': renderAnalyticsTab(el); break;
        }
    }

    // --- General Tab ---
    function renderGeneralTab(el) {
        const v = selectedVideo;
        if (!v) return;

        // Auto-fill logic for imported videos
        let autoHook = v.hook || '';
        let autoLinks = v.links || '';
        if (v.youtubeVideoId) {
            if (!autoHook && analysisData) {
                const transcript = analysisData.transcript || {};
                if (transcript.fullText) {
                    autoHook = transcript.fullText.split(/[.!?]/)[0].trim();
                }
            }
            if (!autoLinks) {
                autoLinks = `https://youtube.com/watch?v=${v.youtubeVideoId}`;
            }
        }

        // Source idea badge
        let sourceIdeaHtml = '';
        if (v.sourceIdeaId) {
            const idea = NotesService.getById(v.sourceIdeaId);
            sourceIdeaHtml = `<div class="pen-source-idea">Source Idea: ${escHtml(idea ? idea.name : v.sourceIdeaId)}</div>`;
        }

        // "Link YouTube URL" section for workshop videos (no youtubeVideoId)
        let linkYouTubeHtml = '';
        if (!v.youtubeVideoId) {
            linkYouTubeHtml = `
                <div class="pen-general-link-yt">
                    <h4>Link YouTube Video</h4>
                    <p>Paste a YouTube URL to analyze this video and unlock Video, Overview, Transcript, Frames, and Analytics tabs.</p>
                    <div class="pen-general-link-yt-row">
                        <input type="text" id="pen-link-yt-url" placeholder="https://youtube.com/watch?v=...">
                        <button id="pen-link-yt-btn">Analyze</button>
                    </div>
                </div>
            `;
        }

        el.innerHTML = `
            <div class="pen-general-tab">
                <div class="pen-detail-egg-inline">
                    <canvas id="pen-detail-creature-canvas" class="pen-creature-preview-canvas" width="120" height="120"></canvas>
                </div>
                <div class="pen-detail-fields">
                    ${sourceIdeaHtml}
                    <label>Video Name</label>
                    <input type="text" id="pen-name" value="${escAttr(v.name)}">
                    <label>Project</label>
                    <select id="pen-project">
                        <option value="">No project</option>
                        ${projects.map(p => `<option value="${escAttr(p)}" ${p === v.project ? 'selected' : ''}>${escHtml(p)}</option>`).join('')}
                    </select>
                    <label>Posted Date</label>
                    <input type="text" id="pen-date" value="${escAttr(v.postedDate || '')}" placeholder="YYYY-MM-DD">
                    <label>Hook</label>
                    <textarea id="pen-hook" placeholder="What's the hook?">${escHtml(autoHook)}</textarea>
                    <label>Context</label>
                    <textarea id="pen-context" placeholder="More details, angles, notes...">${escHtml(v.context || '')}</textarea>
                    <label>Script</label>
                    ${window.EggRenderer ? window.EggRenderer.inlineScriptEditorHtml('pen-inline-script', 'Script') : '<textarea id="pen-script"></textarea>'}
                    <label>Links</label>
                    <textarea id="pen-links" placeholder="YouTube, TikTok, Instagram URLs...">${escHtml(autoLinks)}</textarea>
                </div>
                ${linkYouTubeHtml}
            </div>
        `;

        // Inline script editor — reads/writes video.script directly
        if (window.EggRenderer) {
            window.EggRenderer.initInlineScriptEditor('pen-inline-script', {
                get: () => (selectedVideo && selectedVideo.script) || '',
                save: async (text) => {
                    if (!selectedVideo) return;
                    selectedVideo.script = text;
                    await VideoService.update(selectedVideo.id, { script: text });
                }
            });
        }

        // Init 3D creature preview
        function updateCreaturePreview() {
            if (!window.EggRenderer) return;
            const proj = document.getElementById('pen-project')?.value || '';
            const seed = proj || (document.getElementById('pen-name')?.value || v.name);
            const ghost = !proj;
            window.EggRenderer.renderCreatureSnapshot(seed, document.getElementById('pen-detail-creature-canvas'), 60, ghost ? { ghost: true } : undefined);
        }
        requestAnimationFrame(updateCreaturePreview);

        // Live-update creature when project changes
        document.getElementById('pen-project')?.addEventListener('change', updateCreaturePreview);

        // Link YouTube URL handler
        const linkBtn = document.getElementById('pen-link-yt-btn');
        if (linkBtn) {
            linkBtn.addEventListener('click', handleLinkYouTube);
            document.getElementById('pen-link-yt-url')?.addEventListener('keydown', e => {
                if (e.key === 'Enter') handleLinkYouTube();
            });
        }
    }

    async function handleLinkYouTube() {
        const input = document.getElementById('pen-link-yt-url');
        const btn = document.getElementById('pen-link-yt-btn');
        if (!input || !btn || !selectedVideo) return;

        const url = input.value.trim();
        const ids = parseYouTubeUrls(url);
        if (ids.length === 0) { alert('No valid YouTube URL found.'); return; }

        btn.disabled = true;
        btn.textContent = 'Starting...';

        // Save any form edits first
        await saveGeneralFields();

        try {
            const result = await VideoService.startVideoAnalysis(`https://youtube.com/watch?v=${ids[0]}`);
            if (result.error) { alert(result.error); btn.disabled = false; btn.textContent = 'Analyze'; return; }

            const ytId = result.jobId;
            await VideoService.update(selectedVideo.id, {
                youtubeVideoId: ytId,
                analysisStatus: 'analyzing'
            });
            selectedVideo = VideoService.getById(selectedVideo.id);

            // Re-render — will now show all tabs + start polling
            activeTab = 'general';
            analysisData = null;
            renderDetail();
        } catch (e) {
            alert('Failed to start analysis: ' + (e.message || e));
            btn.disabled = false;
            btn.textContent = 'Analyze';
        }
    }

    async function saveGeneralFields() {
        if (!selectedVideo) return;
        const name = document.getElementById('pen-name')?.value.trim() || selectedVideo.name;
        const project = document.getElementById('pen-project')?.value || '';
        const postedDate = document.getElementById('pen-date')?.value || '';
        const hook = document.getElementById('pen-hook')?.value || '';
        const context = document.getElementById('pen-context')?.value || '';
        const links = document.getElementById('pen-links')?.value || '';
        await VideoService.saveWithIdeaSync(selectedVideo.id, { name, project, postedDate, hook, context, links });
        selectedVideo = VideoService.getById(selectedVideo.id);
    }

    // --- Video Tab ---
    async function renderVideoTab(el) {
        // Use stored path, or construct from title as fallback
        let dropboxPath = analysisData.dropboxPath;
        if (!dropboxPath && analysisData.metadata?.title) {
            const title = (analysisData.metadata.title || 'Untitled').replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
            dropboxPath = `/Final Videos/${title}/video.mp4`;
        }
        if (!dropboxPath) {
            el.innerHTML = '<div style="text-align:center;padding:40px;color:#888;">Video file not available.</div>';
            return;
        }

        el.innerHTML = '<div style="text-align:center;padding:40px;color:#888;">Loading video...</div>';

        try {
            const res = await fetch('/api/dropbox/get_temporary_link', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: dropboxPath })
            });
            const data = await res.json();
            if (data.error || !data.link) {
                const errMsg = typeof data.error === 'object' ? (data.error.message || JSON.stringify(data.error)) : (data.error || 'No link returned');
                el.innerHTML = `<div style="text-align:center;padding:40px;color:#888;">
                    <p style="color:#e74c3c;font-weight:600;">Could not load video</p>
                    <p style="font-size:13px;margin-top:8px;">The video may not have been uploaded to Dropbox yet, or the file path doesn't match.</p>
                    <p style="font-size:11px;margin-top:8px;color:#aaa;">Path tried: ${escHtml(dropboxPath)}</p>
                    <p style="font-size:11px;color:#aaa;">${escHtml(errMsg)}</p>
                </div>`;
                return;
            }

            // Get poster from first frame
            const firstFrame = (analysisData.frames || [])[0];
            const posterUrl = firstFrame ? `/api/video/frame/${encodeURIComponent(analysisData.videoId)}/${encodeURIComponent(firstFrame.filename)}` : '';

            el.innerHTML = `
                <div class="pen-video-player-wrap">
                    <video controls playsinline ${posterUrl ? `poster="${posterUrl}"` : ''} style="width:100%;max-height:500px;border-radius:12px;background:#000;">
                        <source src="${escAttr(data.link)}" type="video/mp4">
                        Your browser does not support video playback.
                    </video>
                    <div style="text-align:center;margin-top:8px;font-size:12px;color:#888;">Streaming from Dropbox</div>
                </div>
            `;
        } catch (e) {
            el.innerHTML = `<div style="text-align:center;padding:40px;color:#e74c3c;">Failed to load video: ${escHtml(e.message)}</div>`;
        }
    }

    // --- Overview Tab ---
    function renderOverviewTab(el) {
        const meta = analysisData.metadata || {};
        const ai = analysisData.aiAnalysis || {};
        const analytics = analysisData.analytics || {};
        const hasAnalytics = analytics.totalViews != null;

        el.innerHTML = `
            ${hasAnalytics ? '<div id="pen-overview-perf-score"></div>' : ''}
            ${ai.videoIdea ? `<div class="pen-idea-badge">${escHtml(ai.videoIdea)}</div>` : ''}

            <div class="pen-overview-card">
                <h3>Metadata</h3>
                <div class="pen-meta-grid">
                    <div class="pen-meta-item"><div class="pen-meta-value">${formatDuration(meta.duration)}</div><div class="pen-meta-label">Duration</div></div>
                    <div class="pen-meta-item"><div class="pen-meta-value">${formatNumber(meta.viewCount)}</div><div class="pen-meta-label">Views</div></div>
                    <div class="pen-meta-item"><div class="pen-meta-value">${formatNumber(meta.likeCount)}</div><div class="pen-meta-label">Likes</div></div>
                    <div class="pen-meta-item"><div class="pen-meta-value">${formatNumber(meta.commentCount)}</div><div class="pen-meta-label">Comments</div></div>
                    <div class="pen-meta-item"><div class="pen-meta-value">${meta.uploadDate ? meta.uploadDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : '—'}</div><div class="pen-meta-label">Upload Date</div></div>
                </div>
            </div>

            ${ai.summary ? `<div class="pen-overview-card"><h3>Summary</h3><div class="pen-summary-text">${escHtml(ai.summary)}</div></div>` : ''}

            ${ai.segments && ai.segments.length > 0 ? `
                <div class="pen-overview-card">
                    <h3>Segments</h3>
                    <div class="pen-segments-list">
                        ${ai.segments.map((seg, i) => `
                            <div class="pen-segment-item" data-idx="${i}">
                                <div class="pen-segment-header">
                                    <span class="pen-segment-label">${escHtml(seg.label || 'Segment ' + (i + 1))}</span>
                                    <span class="pen-segment-time">${formatDuration(seg.startTime)} – ${formatDuration(seg.endTime)}</span>
                                </div>
                                <div class="pen-segment-body">
                                    ${seg.description ? `<div class="pen-segment-desc">${escHtml(seg.description)}</div>` : ''}
                                    ${seg.transcript ? `<div class="pen-segment-transcript">${escHtml(seg.transcript)}</div>` : ''}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
        `;

        // Segment accordion
        el.querySelectorAll('.pen-segment-header').forEach(header => {
            header.addEventListener('click', () => {
                header.parentElement.classList.toggle('open');
            });
        });

        // Fetch performance score for overview tab
        if (hasAnalytics) {
            fetchPerformanceScore(analysisData.videoId, 'pen-overview-perf-score');
        }
    }

    // --- Transcript Tab ---
    function renderTranscriptTab(el) {
        const transcript = analysisData.transcript || {};

        if (!transcript.fullText) {
            el.innerHTML = '<div style="text-align:center;padding:40px;color:#888;">No transcript available for this video.</div>';
            return;
        }

        el.innerHTML = `
            <div class="pen-transcript-view">
                <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
                    <button id="pen-copy-transcript" style="background:#00b894;color:white;border:none;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer;">Copy to Clipboard</button>
                </div>
                <div class="pen-transcript-text" id="pen-transcript-text">${escHtml(transcript.fullText)}</div>
            </div>
        `;

        document.getElementById('pen-copy-transcript').addEventListener('click', () => {
            navigator.clipboard.writeText(transcript.fullText).then(() => {
                const btn = document.getElementById('pen-copy-transcript');
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = 'Copy to Clipboard'; }, 1500);
            });
        });
    }

    // --- Frames Tab ---
    function renderFramesTab(el) {
        const frames = analysisData.frames || [];
        const ytId = analysisData.videoId;

        if (frames.length === 0) {
            el.innerHTML = '<div style="text-align:center;padding:40px;color:#888;">No frames extracted.</div>';
            return;
        }

        const analyzedCount = frames.filter(f => f.analysis && !f.analysis.error).length;
        const unanalyzedCount = frames.length - analyzedCount;

        // Header with stats and re-analyze button
        let headerHtml = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <span style="font-size:13px;color:#888;">${frames.length} frames, ${analyzedCount} analyzed</span>`;
        if (unanalyzedCount > 0) {
            headerHtml += `<button id="pen-reanalyze-btn" style="background:#00b894;color:white;border:none;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer;">Re-analyze All Frames (${unanalyzedCount} missing)</button>`;
        }
        headerHtml += '</div>';

        // Always render as vertical-friendly initially, then detect from first image
        let html = headerHtml + '<div class="pen-frames-grid" id="pen-frames-grid-el">';
        for (const frame of frames) {
            let colorClass = '';
            if (frame.analysis && frame.analysis.retentionAnalysis) {
                const ra = frame.analysis.retentionAnalysis.toLowerCase();
                if (ra.includes('stay') || ra.includes('engage') || ra.includes('hook') || ra.includes('effective')) colorClass = 'retention-positive';
                else if (ra.includes('leave') || ra.includes('drop') || ra.includes('skip') || ra.includes('lose')) colorClass = 'retention-negative';
                else colorClass = 'retention-neutral';
            }
            const isExpanded = expandedFrameIdx === frame.index;
            const noAnalysis = !frame.analysis ? 'pen-frame-no-analysis' : '';

            html += `
                <div class="pen-frame-card ${colorClass} ${isExpanded ? 'selected' : ''} ${noAnalysis}" data-idx="${frame.index}">
                    <img src="/api/video/frame/${encodeURIComponent(ytId)}/${encodeURIComponent(frame.filename)}" alt="Frame at ${frame.timestamp}s" loading="lazy">
                    <div class="pen-frame-time-badge">${formatDuration(frame.timestamp)}</div>
                </div>
            `;

            if (isExpanded && frame.analysis) {
                html += renderFrameExpanded(frame);
            }
        }
        html += '</div>';
        el.innerHTML = html;

        // Detect vertical from first loaded image and adjust grid
        const firstImg = el.querySelector('.pen-frame-card img');
        if (firstImg) {
            const onLoad = () => {
                if (firstImg.naturalHeight > firstImg.naturalWidth) {
                    // Vertical video — add vertical classes
                    const grid = document.getElementById('pen-frames-grid-el');
                    if (grid) grid.classList.add('pen-frames-vertical');
                    el.querySelectorAll('.pen-frame-card img').forEach(img => {
                        img.classList.add('pen-frame-img-vertical');
                    });
                }
            };
            if (firstImg.complete) onLoad();
            else firstImg.addEventListener('load', onLoad);
        }

        // Click to expand
        el.querySelectorAll('.pen-frame-card').forEach(card => {
            card.addEventListener('click', () => {
                const idx = parseInt(card.dataset.idx);
                expandedFrameIdx = expandedFrameIdx === idx ? null : idx;
                renderFramesTab(el);
            });
        });

        // Re-analyze button
        const reBtn = document.getElementById('pen-reanalyze-btn');
        if (reBtn) {
            reBtn.addEventListener('click', async () => {
                reBtn.disabled = true;
                reBtn.textContent = 'Starting re-analysis...';
                try {
                    const res = await fetch('/api/video/reanalyze-frames', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ videoId: ytId })
                    });
                    const data = await res.json();
                    if (data.error) { alert(data.error); reBtn.disabled = false; return; }
                    // Poll for completion
                    reBtn.textContent = 'Analyzing frames...';
                    const poll = setInterval(async () => {
                        const status = await VideoService.getAnalysisStatus(ytId);
                        if (!status) return;
                        reBtn.textContent = `Analyzing frames... ${status.progress || 0}%`;
                        if (status.status === 'complete') {
                            clearInterval(poll);
                            analysisData = await VideoService.getVideoAnalysis(ytId);
                            renderFramesTab(el);
                        } else if (status.status === 'error') {
                            clearInterval(poll);
                            alert('Frame analysis failed: ' + (status.error || 'Unknown'));
                            reBtn.disabled = false;
                            reBtn.textContent = 'Re-analyze All Frames';
                        }
                    }, 2000);
                } catch (e) { alert('Failed: ' + e.message); reBtn.disabled = false; }
            });
        }
    }

    function renderFrameExpanded(frame) {
        const a = frame.analysis;
        if (!a) return '';
        return `
            <div class="pen-frame-expanded">
                ${a.sceneDescription ? `<h4>Scene</h4><p>${escHtml(a.sceneDescription)}</p>` : ''}
                ${a.visualTechniques ? `<h4>Visual Techniques</h4><p>${escHtml(a.visualTechniques)}</p>` : ''}
                ${a.cinematography ? `<h4>Cinematography</h4><p>${escHtml(a.cinematography)}</p>` : ''}
                ${a.engagementAnalysis ? `<h4>Engagement</h4><p>${escHtml(a.engagementAnalysis)}</p>` : ''}
                ${a.keyInsights && a.keyInsights.length ? `<h4>Key Insights</h4><ul>${a.keyInsights.map(i => `<li>${escHtml(i)}</li>`).join('')}</ul>` : ''}
                ${a.accessibilityNotes ? `<h4>Accessibility</h4><p>${escHtml(a.accessibilityNotes)}</p>` : ''}
                ${a.retentionAnalysis ? `<h4>Retention</h4><p>${escHtml(a.retentionAnalysis)}</p>` : ''}
            </div>
        `;
    }

    // --- Analytics Tab ---
    async function renderAnalyticsTab(el) {
        const analytics = analysisData.analytics || {};
        const hasData = analytics.retentionCurve && analytics.retentionCurve.length > 0;

        if (!hasData) {
            // Check YouTube connection status
            el.innerHTML = '<div style="text-align:center;padding:40px;color:#888;">Checking YouTube connection...</div>';
            let ytStatus = { hasCredentials: false, isConnected: false };
            try {
                const res = await fetch('/api/youtube/status');
                ytStatus = await res.json();
            } catch (e) {}

            if (ytStatus.isConnected) {
                // Connected — offer to fetch analytics for this video
                el.innerHTML = `
                    <div class="pen-connect-yt">
                        <div class="pen-yt-status-bar">
                            <span style="color:#27ae60;font-weight:700;">YouTube connected</span>
                            <button id="pen-yt-disconnect" class="pen-yt-disconnect-btn">Disconnect</button>
                        </div>
                        <button id="pen-yt-fetch-btn">Fetch Analytics for This Video</button>
                        <p>Pull retention curve, engagement stats, and revenue from YouTube Studio.</p>
                    </div>
                `;
                document.getElementById('pen-yt-fetch-btn').addEventListener('click', async () => {
                    const btn = document.getElementById('pen-yt-fetch-btn');
                    btn.disabled = true; btn.textContent = 'Fetching...';
                    try {
                        const res = await fetch(`/api/youtube/analytics/${analysisData.videoId}`);
                        const data = await res.json();
                        if (data.error) { alert(data.error); btn.disabled = false; btn.textContent = 'Fetch Analytics for This Video'; return; }
                        analysisData.analytics = data;
                        if (data.likes != null) analysisData.metadata.likeCount = data.likes;
                        if (data.comments != null) analysisData.metadata.commentCount = data.comments;
                        if (data.totalViews != null) analysisData.metadata.viewCount = data.totalViews;
                        renderAnalyticsTab(el);
                    } catch (e) { alert('Failed: ' + e.message); btn.disabled = false; btn.textContent = 'Fetch Analytics for This Video'; }
                });
                document.getElementById('pen-yt-disconnect').addEventListener('click', () => handleYouTubeDisconnect(el));
                return;
            }

            if (ytStatus.hasCredentials) {
                // Has credentials but not connected — show sign-in button
                el.innerHTML = `
                    <div class="pen-connect-yt">
                        <h3 style="font-family:'Fredoka One',sans-serif;color:#333;margin-bottom:12px;">Sign in to YouTube</h3>
                        <button id="pen-yt-connect-btn">Sign in with YouTube</button>
                        <p>Connect your YouTube account to fetch retention, analytics, and revenue data.</p>
                    </div>
                `;
                document.getElementById('pen-yt-connect-btn').addEventListener('click', () => openYouTubeAuth(el));
                return;
            }

            // No credentials — show setup form
            el.innerHTML = `
                <div class="pen-connect-yt">
                    <h3 style="font-family:'Fredoka One',sans-serif;color:#333;margin-bottom:8px;">YouTube Analytics Setup</h3>
                    <p style="margin-bottom:16px;">One-time setup to connect your YouTube Studio data. After this, you'll never need to do it again.</p>

                    <div class="pen-yt-setup-steps">
                        <div class="pen-yt-step">
                            <div class="pen-yt-step-num">1</div>
                            <div>Go to <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color:#00b894;font-weight:700;">Google Cloud Console</a> and create an OAuth 2.0 Client ID (Web application)</div>
                        </div>
                        <div class="pen-yt-step">
                            <div class="pen-yt-step-num">2</div>
                            <div>Enable the <a href="https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com" target="_blank" style="color:#00b894;font-weight:700;">YouTube Analytics API</a> and add redirect URI: <code style="background:#f0f0f0;padding:2px 6px;border-radius:4px;font-size:12px;">http://localhost:8002/api/youtube/callback</code></div>
                        </div>
                        <div class="pen-yt-step">
                            <div class="pen-yt-step-num">3</div>
                            <div>Paste your credentials below:</div>
                        </div>
                    </div>

                    <div style="display:flex;flex-direction:column;gap:10px;margin-top:16px;max-width:450px;margin-left:auto;margin-right:auto;">
                        <input type="text" id="pen-yt-client-id" placeholder="Client ID" style="border:1px solid #d8e4d8;border-radius:10px;padding:10px 14px;font-size:14px;font-family:inherit;">
                        <input type="text" id="pen-yt-client-secret" placeholder="Client Secret" style="border:1px solid #d8e4d8;border-radius:10px;padding:10px 14px;font-size:14px;font-family:inherit;">
                        <button id="pen-yt-save-creds" style="background:#00b894;color:white;border:none;border-radius:10px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;">Save & Connect YouTube</button>
                    </div>
                </div>
            `;

            document.getElementById('pen-yt-save-creds').addEventListener('click', async () => {
                const clientId = document.getElementById('pen-yt-client-id').value.trim();
                const clientSecret = document.getElementById('pen-yt-client-secret').value.trim();
                if (!clientId || !clientSecret) { alert('Please enter both Client ID and Client Secret'); return; }
                const btn = document.getElementById('pen-yt-save-creds');
                btn.disabled = true; btn.textContent = 'Saving...';
                try {
                    const res = await fetch('/api/youtube/save-credentials', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ clientId, clientSecret })
                    });
                    const data = await res.json();
                    if (data.error) { alert(data.error); btn.disabled = false; btn.textContent = 'Save & Connect YouTube'; return; }
                    // Now trigger OAuth sign-in
                    renderAnalyticsTab(el);
                } catch (e) { alert('Failed to save: ' + e.message); btn.disabled = false; btn.textContent = 'Save & Connect YouTube'; }
            });
            return;
        }

        // Performance scoring — fetch in background
        let perfScoreHtml = '<div id="pen-perf-score"></div>';

        // Swipe Ratio — real YouTube Studio "Viewed vs Swiped Away" (from Playwright scraper)
        // This is a SEPARATE metric from Engagement Rate
        let swipeBarHtml = '';
        const swipe = analytics.swipeRatio;
        const hasRealSwipe = swipe && typeof swipe === 'object' && swipe.scrapedAt && swipe.stayedToWatch != null;
        if (hasRealSwipe) {
            const stayed = swipe.stayedToWatch;
            const swiped = swipe.swipedAway;

            let subSwipeHtml = '';
            if (swipe.subscriberStayed != null || swipe.nonSubscriberStayed != null) {
                subSwipeHtml = '<div class="pen-swipe-sub-breakdown">';
                if (swipe.subscriberStayed != null) {
                    subSwipeHtml += `
                        <div class="pen-swipe-sub-row">
                            <span class="pen-swipe-sub-label" style="color:#0984e3;">Subscribers</span>
                            <div class="pen-engagement-bar-wrap pen-swipe-sub-bar">
                                <div class="pen-engagement-stayed" style="width:${swipe.subscriberStayed}%;background:#0984e3;">
                                    <span>${swipe.subscriberStayed}%</span>
                                </div>
                                <div class="pen-engagement-swiped" style="width:${swipe.subscriberSwiped}%;background:#b2bec3;">
                                    <span>${swipe.subscriberSwiped}%</span>
                                </div>
                            </div>
                        </div>`;
                }
                if (swipe.nonSubscriberStayed != null) {
                    subSwipeHtml += `
                        <div class="pen-swipe-sub-row">
                            <span class="pen-swipe-sub-label" style="color:#6c5ce7;">Non-Subscribers</span>
                            <div class="pen-engagement-bar-wrap pen-swipe-sub-bar">
                                <div class="pen-engagement-stayed" style="width:${swipe.nonSubscriberStayed}%;background:#6c5ce7;">
                                    <span>${swipe.nonSubscriberStayed}%</span>
                                </div>
                                <div class="pen-engagement-swiped" style="width:${swipe.nonSubscriberSwiped}%;background:#b2bec3;">
                                    <span>${swipe.nonSubscriberSwiped}%</span>
                                </div>
                            </div>
                        </div>`;
                }
                subSwipeHtml += '</div>';
            }

            swipeBarHtml = `
                <div class="pen-overview-card pen-swipe-card">
                    <h3>Viewed vs Swiped Away</h3>
                    <div class="pen-engagement-bar-wrap">
                        <div class="pen-engagement-stayed" style="width:${stayed}%;background:#27ae60;">
                            <span>${stayed}% Stayed to watch</span>
                        </div>
                        <div class="pen-engagement-swiped" style="width:${swiped}%;background:#e74c3c;">
                            <span>${swiped}%</span>
                        </div>
                    </div>
                    ${subSwipeHtml}
                    <div style="margin-top:8px;font-size:12px;color:#888;">From YouTube Studio &mdash; ${new Date(swipe.scrapedAt).toLocaleDateString()}</div>
                </div>
            `;
        }

        // Engagement Rate — engagedViews / totalViews (different metric from swipe ratio)
        let engagementHtml = '';
        if (analytics.engagedViews != null && analytics.totalViews > 0) {
            const engRate = (analytics.engagedViews / analytics.totalViews * 100);
            const engPct = Math.min(100, engRate).toFixed(1);
            const notEngPct = Math.max(0, 100 - engRate).toFixed(1);

            engagementHtml = `
                <div class="pen-overview-card pen-engagement-card">
                    <h3>Engagement Rate</h3>
                    <div class="pen-engagement-bar-wrap">
                        <div class="pen-engagement-stayed" style="width:${engPct}%">
                            <span>${engPct}% Engaged</span>
                        </div>
                        <div class="pen-engagement-swiped" style="width:${notEngPct}%">
                            <span>${notEngPct}%</span>
                        </div>
                    </div>
                    <div style="margin-top:8px;font-size:12px;color:#888;">${formatNumber(analytics.engagedViews)} engaged of ${formatNumber(analytics.totalViews)} views${!hasRealSwipe ? ' &mdash; <button id="pen-fetch-swipe-btn" class="pen-swipe-fetch-inline">Fetch real swipe ratio</button>' : ''}</div>
                </div>
            `;
        }

        // Stat cards
        const retClass = analytics.avgRetention != null ? (analytics.avgRetention > 0.5 ? 'retention-positive' : analytics.avgRetention > 0.3 ? 'retention-neutral' : 'retention-negative') : '';

        // Subscriber vs non-subscriber breakdown
        let subBreakdownHtml = '';
        if (analytics.subscriberViews != null || analytics.nonSubscriberViews != null) {
            const totalV = (analytics.subscriberViews || 0) + (analytics.nonSubscriberViews || 0);
            const subPct = totalV > 0 ? ((analytics.subscriberViews || 0) / totalV * 100).toFixed(1) : '—';
            const nonSubPct = totalV > 0 ? ((analytics.nonSubscriberViews || 0) / totalV * 100).toFixed(1) : '—';
            subBreakdownHtml = `
                <div class="pen-overview-card" style="margin-top:16px;">
                    <h3>Subscriber vs Non-Subscriber</h3>
                    <div class="pen-stat-cards">
                        <div class="pen-stat-card">
                            <div class="pen-stat-value" style="color:#0984e3;">${formatNumber(analytics.subscriberViews)}</div>
                            <div class="pen-stat-label">Subscriber Views</div>
                            <div style="font-size:11px;color:#888;margin-top:2px;">${subPct}% of total</div>
                        </div>
                        <div class="pen-stat-card">
                            <div class="pen-stat-value" style="color:#6c5ce7;">${formatNumber(analytics.nonSubscriberViews)}</div>
                            <div class="pen-stat-label">Non-Sub Views</div>
                            <div style="font-size:11px;color:#888;margin-top:2px;">${nonSubPct}% of total</div>
                        </div>
                        ${analytics.subscriberAvgPercent != null ? `<div class="pen-stat-card">
                            <div class="pen-stat-value" style="color:#0984e3;">${analytics.subscriberAvgPercent.toFixed(1)}%</div>
                            <div class="pen-stat-label">Sub Avg % Viewed</div>
                        </div>` : ''}
                        ${analytics.nonSubscriberAvgPercent != null ? `<div class="pen-stat-card">
                            <div class="pen-stat-value" style="color:#6c5ce7;">${analytics.nonSubscriberAvgPercent.toFixed(1)}%</div>
                            <div class="pen-stat-label">Non-Sub Avg % Viewed</div>
                        </div>` : ''}
                    </div>
                </div>
            `;
        }

        el.innerHTML = `
            ${perfScoreHtml}
            ${swipeBarHtml}
            <div class="pen-analytics-chart">
                <canvas id="pen-retention-canvas"></canvas>
                <div id="pen-chart-tooltip" style="display:none;position:absolute;background:rgba(0,0,0,0.85);color:white;padding:6px 12px;border-radius:8px;font-size:13px;font-weight:600;pointer-events:none;z-index:10;"></div>
            </div>
            ${engagementHtml}
            <div class="pen-stat-cards">
                <div class="pen-stat-card">
                    <div class="pen-stat-value ${retClass}">${analytics.avgRetention != null ? (analytics.avgRetention * 100).toFixed(1) + '%' : '—'}</div>
                    <div class="pen-stat-label">Avg Retention</div>
                </div>
                <div class="pen-stat-card">
                    <div class="pen-stat-value">${analytics.avgPercentViewed != null ? analytics.avgPercentViewed.toFixed(1) + '%' : '—'}</div>
                    <div class="pen-stat-label">Avg % Viewed</div>
                </div>
                <div class="pen-stat-card">
                    <div class="pen-stat-value">${analytics.avgViewDuration != null ? formatDuration(analytics.avgViewDuration) : '—'}</div>
                    <div class="pen-stat-label">Avg Watch Time</div>
                </div>
                ${analytics.estimatedRevenue != null ? `<div class="pen-stat-card">
                    <div class="pen-stat-value" style="color:#2ecc71;">C$${(analytics.estimatedRevenue * USD_TO_CAD).toFixed(2)}</div>
                    <div class="pen-stat-label">Revenue</div>
                    <div style="font-size:11px;color:#888;margin-top:2px;">(USD: $${analytics.estimatedRevenue.toFixed(2)})</div>
                </div>` : ''}
                ${analytics.likes != null ? `<div class="pen-stat-card">
                    <div class="pen-stat-value" style="color:#e74c3c;">${formatNumber(analytics.likes)}</div>
                    <div class="pen-stat-label">Likes</div>
                </div>` : ''}
                ${analytics.shares != null ? `<div class="pen-stat-card">
                    <div class="pen-stat-value" style="color:#0984e3;">${formatNumber(analytics.shares)}</div>
                    <div class="pen-stat-label">Shares</div>
                </div>` : ''}
                ${analytics.subscribersGained != null ? `<div class="pen-stat-card">
                    <div class="pen-stat-value retention-positive">+${formatNumber(analytics.subscribersGained)}</div>
                    <div class="pen-stat-label">Subs Gained</div>
                </div>` : ''}
            </div>
            ${subBreakdownHtml}
            ${analytics.estimatedRevenue == null ? `
                <div class="pen-revenue-warning">
                    Revenue data not available. You may need to disconnect and reconnect YouTube with updated permissions.
                </div>
            ` : ''}
            <div class="pen-yt-actions-bar">
                <button id="pen-yt-refresh-btn" class="pen-yt-action-btn pen-yt-refresh">Refresh Analytics</button>
                <button id="pen-fetch-swipe-all" class="pen-yt-action-btn pen-swipe-btn">Fetch Swipe Ratios</button>
                <button id="pen-yt-disconnect2" class="pen-yt-disconnect-btn">Disconnect YouTube</button>
            </div>
        `;

        // Draw interactive retention chart
        requestAnimationFrame(() => drawRetentionChart(analytics));

        // Fetch performance score in background
        fetchPerformanceScore(analysisData.videoId);

        // Fetch trend arrows from analytics history
        fetchAndRenderTrends(analysisData.videoId);

        // Refresh analytics button
        document.getElementById('pen-yt-refresh-btn')?.addEventListener('click', async () => {
            const btn = document.getElementById('pen-yt-refresh-btn');
            btn.disabled = true; btn.textContent = 'Fetching...';
            try {
                const res = await fetch(`/api/youtube/analytics/${analysisData.videoId}`);
                const data = await res.json();
                if (data.error) { alert(data.error); btn.disabled = false; btn.textContent = 'Refresh Analytics'; return; }
                analysisData.analytics = data;
                // Update metadata with fresh counts
                if (data.likes != null) analysisData.metadata.likeCount = data.likes;
                if (data.comments != null) analysisData.metadata.commentCount = data.comments;
                if (data.totalViews != null) analysisData.metadata.viewCount = data.totalViews;
                renderAnalyticsTab(el);
            } catch (e) { alert('Failed: ' + e.message); btn.disabled = false; btn.textContent = 'Refresh Analytics'; }
        });

        // Disconnect button
        document.getElementById('pen-yt-disconnect2')?.addEventListener('click', () => handleYouTubeDisconnect(el));

        // Inline "Fetch real swipe ratio" link (single video)
        document.getElementById('pen-fetch-swipe-btn')?.addEventListener('click', () => startSwipeScrape(el));

        // "Fetch Swipe Ratios" button (all videos)
        document.getElementById('pen-fetch-swipe-all')?.addEventListener('click', () => startSwipeScrape(el));
    }

    async function startSwipeScrape(analyticsEl) {
        const btn = document.getElementById('pen-fetch-swipe-all');
        if (btn) { btn.textContent = 'Opening Chrome...'; btn.disabled = true; }

        try {
            // Kick off the scraper (opens Chrome, handles login + scraping)
            const res = await fetch('/api/youtube/fetch-swipe-ratios', { method: 'POST' });
            const data = await res.json();

            if (data.total === 0) {
                alert('All videos already have swipe data!');
                if (btn) { btn.textContent = 'Fetch Swipe Ratios'; btn.disabled = false; }
                return;
            }

            // Poll for status updates
            if (btn) btn.textContent = `Log in if prompted... (${data.total} videos)`;

            const pollInterval = setInterval(async () => {
                try {
                    const statusRes = await fetch('/api/youtube/swipe-status');
                    const status = await statusRes.json();

                    if (status.state === 'logging_in' && btn) {
                        btn.textContent = 'Waiting for YouTube login...';
                    } else if (status.state === 'scraping' && btn) {
                        btn.textContent = `Scraping ${status.current}/${status.total}...`;
                    } else if (status.state === 'done') {
                        clearInterval(pollInterval);
                        if (btn) { btn.textContent = 'Fetch Swipe Ratios'; btn.disabled = false; }

                        // Reload current video's analysis to pick up swipe data
                        if (analysisData?.videoId) {
                            try {
                                const aRes = await fetch(`/api/video/analysis/${analysisData.videoId}`);
                                const fresh = await aRes.json();
                                if (fresh?.analytics?.swipeRatio) {
                                    analysisData.analytics.swipeRatio = fresh.analytics.swipeRatio;
                                }
                            } catch (e) {}
                        }

                        const results = status.results || {};
                        const ok = Object.values(results).filter(r => !r.error).length;
                        const fail = Object.values(results).filter(r => r.error).length;
                        alert(`Done! ${ok} videos scraped${fail > 0 ? `, ${fail} failed` : ''}.`);
                        if (analyticsEl) renderAnalyticsTab(analyticsEl);
                    } else if (status.state === 'error') {
                        clearInterval(pollInterval);
                        alert('Scrape failed: ' + (status.error || 'unknown error'));
                        if (btn) { btn.textContent = 'Fetch Swipe Ratios'; btn.disabled = false; }
                    }
                } catch (e) {}
            }, 2000);

            // Timeout after 10 minutes
            setTimeout(() => {
                clearInterval(pollInterval);
                if (btn) { btn.textContent = 'Fetch Swipe Ratios'; btn.disabled = false; }
            }, 600000);
        } catch (e) {
            alert('Failed to start: ' + e.message);
            if (btn) { btn.textContent = 'Fetch Swipe Ratios'; btn.disabled = false; }
        }
    }

    async function handleYouTubeDisconnect(el) {
        try {
            await fetch('/api/youtube/clear-token', { method: 'POST' });
        } catch (e) {}
        // Clear local analytics so user sees the sign-in flow
        if (analysisData) {
            analysisData.analytics = { retentionCurve: [] };
        }
        renderAnalyticsTab(el);
    }

    function openYouTubeAuth(el) {
        fetch('/api/youtube/auth-url')
            .then(r => r.json())
            .then(data => {
                if (data.error) { alert(data.error); return; }
                if (data.url) {
                    const popup = window.open(data.url, 'youtube-auth', 'width=500,height=700');
                    const check = setInterval(() => {
                        if (!popup || popup.closed) { clearInterval(check); renderAnalyticsTab(el); }
                    }, 1000);
                }
            })
            .catch(() => alert('Failed to get auth URL'));
    }

    // Fetch analytics history and render trend arrows
    async function fetchAndRenderTrends(videoId) {
        try {
            const res = await fetch(`/api/video/analytics-history/${videoId}`);
            const data = await res.json();
            if (!data.snapshots || data.snapshots.length < 2) return;

            // Compare latest vs previous snapshot
            const prev = data.snapshots[data.snapshots.length - 2];
            const curr = data.snapshots[data.snapshots.length - 1];

            function trendArrow(currVal, prevVal, higherIsBetter = true) {
                if (currVal == null || prevVal == null) return '';
                const diff = currVal - prevVal;
                if (Math.abs(diff) < 0.01) return '';
                const up = diff > 0;
                const good = higherIsBetter ? up : !up;
                const color = good ? '#27ae60' : '#e74c3c';
                const arrow = up ? '&#9650;' : '&#9660;';
                return `<span class="pen-trend-arrow" style="color:${color};font-size:11px;margin-left:4px;" title="Was ${typeof prevVal === 'number' ? prevVal.toFixed(1) : prevVal}">${arrow}</span>`;
            }

            // Inject trend arrows into stat cards
            document.querySelectorAll('.pen-stat-card').forEach(card => {
                const label = card.querySelector('.pen-stat-label')?.textContent?.trim();
                let arrow = '';
                if (label === 'Avg Retention') arrow = trendArrow(curr.avgRetention, prev.avgRetention);
                else if (label === 'Avg % Viewed') arrow = trendArrow(curr.avgPercentViewed, prev.avgPercentViewed);
                else if (label === 'Likes') arrow = trendArrow(curr.likes, prev.likes);
                else if (label === 'Shares') arrow = trendArrow(curr.shares, prev.shares);
                else if (label === 'Subs Gained') arrow = trendArrow(curr.subscribersGained, prev.subscribersGained);
                else if (label === 'Subscriber Views') arrow = trendArrow(curr.subscriberViews, prev.subscriberViews);
                else if (label === 'Non-Sub Views') arrow = trendArrow(curr.nonSubscriberViews, prev.nonSubscriberViews);

                if (arrow) {
                    const valEl = card.querySelector('.pen-stat-value');
                    if (valEl) valEl.insertAdjacentHTML('beforeend', arrow);
                }
            });

            // Trend arrow on engagement bar (higher engagement is better)
            const engTitle = document.querySelector('.pen-engagement-card h3');
            if (engTitle && curr.engagedViews != null && prev.engagedViews != null &&
                curr.totalViews > 0 && prev.totalViews > 0) {
                const currRate = curr.engagedViews / curr.totalViews * 100;
                const prevRate = prev.engagedViews / prev.totalViews * 100;
                engTitle.insertAdjacentHTML('beforeend', trendArrow(currRate, prevRate, true));
            }
        } catch (e) {
            // Silently fail — trends are optional
        }
    }

    async function fetchPerformanceScore(videoId, elId) {
        const el = document.getElementById(elId || 'pen-perf-score');
        if (!el) return;
        try {
            const res = await fetch(`/api/video/performance-score/${videoId}`);
            const data = await res.json();
            if (data.error && !data.metrics) { el.innerHTML = ''; return; }

            const m = data.metrics;
            if (!m) { el.innerHTML = ''; return; }

            function scoreBar(score) {
                const filled = 11 - score; // 1=best fills most, 10=worst fills least
                const empty = 10 - filled;
                const color = score <= 3 ? '#27ae60' : score <= 6 ? '#f39c12' : '#e74c3c';
                return `<div class="pen-score-bar"><span style="display:inline-block;width:${filled * 10}%;background:${color};height:8px;border-radius:4px 0 0 4px;"></span><span style="display:inline-block;width:${empty * 10}%;background:#e0e0e0;height:8px;border-radius:0 4px 4px 0;"></span></div>`;
            }

            function fmtVal(key, val) {
                if (val == null) return '—';
                if (key === 'avgRetention') return (val * 100).toFixed(1) + '%';
                if (key === 'engagementRate') return val.toFixed(1) + '%';
                if (key === 'revenue') return 'C$' + (val * USD_TO_CAD).toFixed(2);
                if (key === 'views') return formatNumber(val);
                return val;
            }

            // Build typical range bar (like YouTube Studio)
            let typicalBarHtml = '';
            if (data.typicalRange && data.targetViews != null) {
                const { low, median, high } = data.typicalRange;
                // Calculate bar position: where does target fall relative to range?
                const rangeMin = Math.min(low * 0.5, data.targetViews * 0.8);
                const rangeMax = Math.max(high * 1.5, data.targetViews * 1.2);
                const totalRange = rangeMax - rangeMin;
                const lowPct = ((low - rangeMin) / totalRange * 100).toFixed(1);
                const highPct = ((high - rangeMin) / totalRange * 100).toFixed(1);
                const targetPct = Math.max(0, Math.min(100, ((data.targetViews - rangeMin) / totalRange * 100))).toFixed(1);

                typicalBarHtml = `
                    <div class="pen-typical-bar-wrap">
                        <div class="pen-typical-value">${formatNumber(data.targetViews)}</div>
                        <div class="pen-typical-bar">
                            <div class="pen-typical-range" style="left:${lowPct}%;width:${(highPct - lowPct).toFixed(1)}%;"></div>
                            <div class="pen-typical-marker" style="left:${targetPct}%;"></div>
                        </div>
                        <div class="pen-typical-labels">
                            <span style="left:${lowPct}%">${formatNumber(low)}</span>
                            <span style="left:${((parseFloat(lowPct) + parseFloat(highPct)) / 2).toFixed(1)}%">Typical</span>
                            <span style="left:${highPct}%">${formatNumber(high)}</span>
                        </div>
                    </div>
                `;
            }

            // Build per-metric rows
            let metricScoresHtml = '';
            const metricLabels = {
                views: 'Views',
                avgRetention: 'Retention',
                engagementRate: 'Engagement',
                revenue: 'Revenue'
            };
            for (const [key, label] of Object.entries(metricLabels)) {
                if (!m[key]) continue;
                if (key === 'revenue' && !m[key].value) continue;
                const score = m[key].score;
                const val = fmtVal(key, m[key].value);
                if (score != null) {
                    metricScoresHtml += `<div class="pen-perf-metric"><span>${label}</span>${scoreBar(score)}<span class="pen-perf-metric-val">${score}/10</span></div>`;
                } else {
                    metricScoresHtml += `<div class="pen-perf-metric"><span>${label}</span><span class="pen-perf-metric-val" style="margin-left:auto;">${val}</span></div>`;
                }
            }

            // Comparison video list
            let compListHtml = '';
            if (data.compList && data.compList.length > 0) {
                compListHtml = `<div class="pen-comp-list">
                    <div class="pen-comp-list-header">${data.timeLabel || 'Views'}:</div>
                    ${data.compList.map((v, i) => {
                        const isTarget = v.videoId === videoId;
                        return `<div class="pen-comp-item ${isTarget ? 'pen-comp-target' : ''}">
                            <span class="pen-comp-rank">${i + 1}</span>
                            <span class="pen-comp-title">${escHtml(v.title.slice(0, 40))}${v.title.length > 40 ? '...' : ''}</span>
                            <span class="pen-comp-views">${formatNumber(v.viewsAtAge)}</span>
                        </div>`;
                    }).join('')}
                </div>`;
            }

            // Main score display
            let mainScoreHtml = '';
            if (data.typical != null) {
                const score = data.typical;
                const color = score <= 3 ? '#27ae60' : score <= 6 ? '#f39c12' : '#e74c3c';
                mainScoreHtml = `
                    <div class="pen-perf-main-score">
                        <div class="pen-perf-big-score" style="color:${color};">${score}<span>/10</span></div>
                        <div class="pen-perf-score-sublabel">Ranking by views</div>
                        <div class="pen-perf-score-sublabel">${data.comparedTo} of ${data.comparedTo} &rsaquo;</div>
                    </div>
                `;
            }

            el.innerHTML = `
                <div class="pen-perf-scores">
                    ${data.timeLabel ? `<div class="pen-perf-time-label">${data.timeLabel}</div>` : ''}
                    ${mainScoreHtml}
                    ${typicalBarHtml}
                    ${metricScoresHtml ? `<div class="pen-perf-metrics-breakdown">${metricScoresHtml}</div>` : ''}
                    ${compListHtml}
                </div>
            `;
        } catch (e) {
            el.innerHTML = '';
        }
    }

    function drawRetentionChart(analytics) {
        const canvas = document.getElementById('pen-retention-canvas');
        if (!canvas) return;

        const containerEl = canvas.parentElement;
        const dpr = window.devicePixelRatio || 1;
        const cRect = containerEl.getBoundingClientRect();
        canvas.width = cRect.width * dpr;
        canvas.height = 280 * dpr;
        canvas.style.width = cRect.width + 'px';
        canvas.style.height = '280px';

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        const curve = analytics.retentionCurve || [];
        if (curve.length === 0) return;

        const w = cRect.width;
        const h = 280;
        const pad = { top: 16, bottom: 36, left: 52, right: 16 };
        const gw = w - pad.left - pad.right;
        const gh = h - pad.top - pad.bottom;
        const avg = analytics.avgRetention || 0;

        // Dynamic Y-axis: find max retention and round up to nearest 25%
        const maxRetention = Math.max(...curve.map(p => p.retention), avg, 1.0);
        const yMax = Math.ceil(maxRetention * 4) / 4; // round up to nearest 0.25
        const yMaxPct = Math.round(yMax * 100);

        // Convert retention value to Y pixel
        const retToY = (ret) => pad.top + gh * (1 - ret / yMax);

        function draw(hoverIdx) {
            ctx.clearRect(0, 0, w, h);

            // Background grid
            ctx.strokeStyle = '#eee';
            ctx.lineWidth = 1;
            const yStep = yMaxPct <= 150 ? 25 : 50;
            for (let pct = 0; pct <= yMaxPct; pct += yStep) {
                const y = retToY(pct / 100);
                ctx.beginPath();
                ctx.moveTo(pad.left, y);
                ctx.lineTo(w - pad.right, y);
                ctx.stroke();
            }

            // 100% reference line if max > 100%
            if (yMax > 1.0) {
                ctx.strokeStyle = '#ddd';
                ctx.setLineDash([2, 2]);
                ctx.lineWidth = 1;
                const y100 = retToY(1.0);
                ctx.beginPath();
                ctx.moveTo(pad.left, y100);
                ctx.lineTo(w - pad.right, y100);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = '#bbb';
                ctx.font = '10px Nunito, sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText('100%', pad.left + 4, y100 - 3);
            }

            // Avg line
            ctx.strokeStyle = '#bbb';
            ctx.setLineDash([6, 4]);
            ctx.lineWidth = 1;
            const avgY = retToY(avg);
            ctx.beginPath();
            ctx.moveTo(pad.left, avgY);
            ctx.lineTo(w - pad.right, avgY);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#999';
            ctx.font = '11px Nunito, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('avg ' + (avg * 100).toFixed(0) + '%', 2, avgY - 4);

            // Fill area under curve with gradient
            ctx.beginPath();
            ctx.moveTo(pad.left + curve[0].second * gw, pad.top + gh);
            for (const pt of curve) {
                ctx.lineTo(pad.left + pt.second * gw, retToY(pt.retention));
            }
            ctx.lineTo(pad.left + curve[curve.length - 1].second * gw, pad.top + gh);
            ctx.closePath();
            const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + gh);
            gradient.addColorStop(0, 'rgba(0, 184, 148, 0.25)');
            gradient.addColorStop(1, 'rgba(0, 184, 148, 0.02)');
            ctx.fillStyle = gradient;
            ctx.fill();

            // Draw curve segments colored by above/below avg
            ctx.lineWidth = 2.5;
            for (let i = 1; i < curve.length; i++) {
                const x1 = pad.left + curve[i - 1].second * gw;
                const y1 = retToY(curve[i - 1].retention);
                const x2 = pad.left + curve[i].second * gw;
                const y2 = retToY(curve[i].retention);
                ctx.strokeStyle = curve[i].retention >= avg ? '#27ae60' : '#e74c3c';
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
            }

            // X axis labels
            ctx.fillStyle = '#888';
            ctx.font = '11px Nunito, sans-serif';
            ctx.textAlign = 'center';
            for (let pct = 0; pct <= 100; pct += 10) {
                const x = pad.left + (pct / 100) * gw;
                ctx.fillText(pct + '%', x, h - 10);
            }

            // Y axis labels (dynamic)
            ctx.textAlign = 'right';
            for (let pct = 0; pct <= yMaxPct; pct += yStep) {
                const y = retToY(pct / 100);
                ctx.fillText(pct + '%', pad.left - 6, y + 4);
            }
            ctx.textAlign = 'left';

            // Hover crosshair + tooltip
            if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < curve.length) {
                const pt = curve[hoverIdx];
                const hx = pad.left + pt.second * gw;
                const hy = retToY(pt.retention);

                // Vertical line
                ctx.strokeStyle = 'rgba(0,0,0,0.3)';
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(hx, pad.top);
                ctx.lineTo(hx, pad.top + gh);
                ctx.stroke();
                ctx.setLineDash([]);

                // Dot
                ctx.beginPath();
                ctx.arc(hx, hy, 5, 0, Math.PI * 2);
                ctx.fillStyle = pt.retention >= avg ? '#27ae60' : '#e74c3c';
                ctx.fill();
                ctx.strokeStyle = 'white';
                ctx.lineWidth = 2;
                ctx.stroke();

                // Show tooltip
                const tooltip = document.getElementById('pen-chart-tooltip');
                if (tooltip) {
                    const vidDuration = (analysisData.metadata || {}).duration || 0;
                    const timeSec = Math.round(pt.second * vidDuration);
                    tooltip.style.display = 'block';
                    tooltip.innerHTML = `<strong>${(pt.retention * 100).toFixed(1)}%</strong> retention at ${(pt.second * 100).toFixed(0)}% (${formatDuration(timeSec)})`;
                    const tx = Math.min(hx + 10, w - 200);
                    tooltip.style.left = tx + 'px';
                    tooltip.style.top = Math.max(0, hy - 36) + 'px';
                }
            } else {
                const tooltip = document.getElementById('pen-chart-tooltip');
                if (tooltip) tooltip.style.display = 'none';
            }
        }

        draw(null);

        // Mouse interaction for scrubbing
        function getHoverIdx(e) {
            const r = canvas.getBoundingClientRect();
            const mx = e.clientX - r.left;
            const ratio = (mx - pad.left) / gw;
            if (ratio < 0 || ratio > 1) return null;
            let closest = 0;
            let minDist = Math.abs(curve[0].second - ratio);
            for (let i = 1; i < curve.length; i++) {
                const d = Math.abs(curve[i].second - ratio);
                if (d < minDist) { minDist = d; closest = i; }
            }
            return closest;
        }

        canvas.addEventListener('mousemove', (e) => draw(getHoverIdx(e)));
        canvas.addEventListener('mouseleave', () => draw(null));
        canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (e.touches.length > 0) draw(getHoverIdx(e.touches[0]));
        }, { passive: false });
        canvas.addEventListener('touchend', () => draw(null));
    }

    // ============ SAVE / DELETE ============

    async function saveAndBack() {
        stopPolling();
        // Always save General tab fields if they exist in DOM
        if (selectedVideo && document.getElementById('pen-name')) {
            await saveGeneralFields();
        }
        showList();
    }

    async function handleDelete() {
        if (!selectedVideo) return;
        if (!confirm(`Delete "${selectedVideo.name}"?`)) return;
        stopPolling();
        await VideoService.remove(selectedVideo.id);
        showList();
    }

    async function handleImport() {
        try {
            const video = await VideoService.create({
                name: 'Untitled Video',
                status: 'posted',
                postedDate: new Date().toISOString()
            });
            openDetail(video.id);
            setTimeout(() => {
                const nameEl = document.getElementById('pen-name');
                if (nameEl) { nameEl.focus(); nameEl.select(); }
            }, 50);
        } catch (e) {
            console.warn('Pen: import failed', e);
        }
    }

    return {
        async open(bodyEl, opts) {
            container = bodyEl;
            render();
            // Fast path: if opening a specific video, show detail immediately
            if (opts && opts.openVideoId) {
                projects = VideoService.getCachedProjects() || [];
                openDetail(opts.openVideoId);
                // Load remaining data in background for Back navigation
                VideoService.getProjects().then(p => { projects = p; }).catch(() => {});
                VideoService.sync().catch(() => {});
                ScriptService.sync().catch(() => {});
                NotesService.sync().catch(() => {});
                return;
            }
            // Render immediately from in-memory cache (posted videos appear instantly)
            projects = VideoService.getCachedProjects() || [];
            renderFilters();
            renderVideos();
            // Then sync in background for any remote updates
            Promise.all([
                VideoService.getProjects(),
                VideoService.sync(),
                ScriptService.sync().catch(() => {}),
                NotesService.sync().catch(() => {}),
            ]).then(([p]) => {
                projects = p;
                if (container && currentPage === 'list' && !metricsFetching) {
                    renderFilters();
                    renderVideos();
                }
            }).catch(() => {});
        },
        close() {
            stopPolling();
            stopListPolling();
            // Save General tab fields if they exist (works for all video types)
            if (currentPage === 'detail' && selectedVideo && document.getElementById('pen-name')) {
                const name = document.getElementById('pen-name')?.value.trim();
                const project = document.getElementById('pen-project')?.value;
                const postedDate = document.getElementById('pen-date')?.value;
                const hook = document.getElementById('pen-hook')?.value;
                const context = document.getElementById('pen-context')?.value;
                const links = document.getElementById('pen-links')?.value;
                if (name) {
                    VideoService.saveWithIdeaSync(selectedVideo.id, { name, project, postedDate, hook, context, links }).catch(() => {});
                }
            }
            container = null;
            selectedVideo = null;
            analysisData = null;
            filterProject = '';
            currentPage = 'list';
            // Keep sortMetric, metricsCache, and 3D creature scales across close/open
        }
    };
})();

BuildingRegistry.register('The Pen', {
    open: (bodyEl, opts) => PenUI.open(bodyEl, opts),
    close: () => PenUI.close()
});
