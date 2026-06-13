/**
 * Video Lab UI — upload a video (file or YouTube URL), Gemini watches it, then
 * Optimusk Prime coordinates data-backed improvement advice from the Jarvis assets.
 *
 * Flow: pick video → POST /api/gemini/watch → observations → POST /api/videolab/analyze
 *       → poll /api/videolab/advice/:jobId → render the report.
 */
const VideoLabUI = (() => {
    let container = null;
    let observations = null;
    let ytId = null;
    let jobId = null;
    let pollTimer = null;
    let videoUrl = null;

    function render() {
        return `
        <div class="vlab-root">
            <div class="vlab-header">
                <div class="vlab-title">🎬 Video Lab</div>
                <div class="vlab-sub">Upload a video — Gemini watches it, then Optimusk Prime cross-checks every tested indicator, experiment, and your own analytics to tell you exactly how to make it better.</div>
            </div>

            <div class="vlab-input-card">
                <div class="vlab-drop" id="vlab-drop">
                    <input type="file" id="vlab-file" accept="video/*" style="display:none">
                    <div class="vlab-drop-inner">
                        <div class="vlab-drop-icon">⬆</div>
                        <div>Drop a video here or <span class="vlab-link">browse</span></div>
                        <div class="vlab-drop-hint" id="vlab-file-name">mp4, mov, webm</div>
                    </div>
                </div>
                <div class="vlab-or">or</div>
                <div class="vlab-url-row">
                    <input type="text" id="vlab-url" placeholder="Paste a YouTube URL…">
                    <button id="vlab-watch-btn" class="vlab-btn primary">Watch video</button>
                </div>
                <div class="vlab-status" id="vlab-status"></div>
            </div>

            <div class="vlab-obs" id="vlab-obs" style="display:none"></div>
            <div class="vlab-report" id="vlab-report" style="display:none"></div>

            <div id="vlab-history-wrap" style="display:none">
                <div class="vlab-section-title">🗂 Past analyses (saved)</div>
                <div class="vlab-history" id="vlab-history"></div>
            </div>
        </div>`;
    }

    async function loadHistory() {
        try {
            const res = await fetch('/api/videolab/history');
            const items = await res.json();
            if (!Array.isArray(items) || !items.length) return;
            const wrap = document.getElementById('vlab-history-wrap');
            const el = document.getElementById('vlab-history');
            el.innerHTML = items.map(it => `
                <div class="vlab-hist-item" data-job="${esc(it.jobId)}">
                    ${it.overallScore != null ? `<span class="vlab-hist-score">${esc(it.overallScore)}</span>` : ''}
                    <span style="flex:1">${esc(it.videoTitle || it.ytId || it.jobId)}</span>
                    <span style="color:#64748b">${esc((it.finishedAt || '').slice(0, 10))} · ${esc(it.tipCount)} tips</span>
                </div>`).join('');
            wrap.style.display = 'block';
            el.querySelectorAll('.vlab-hist-item').forEach(node => node.addEventListener('click', async () => {
                const r = await fetch('/api/videolab/advice/' + node.dataset.job).then(x => x.json());
                renderReport(r);
                document.getElementById('vlab-report').scrollIntoView({ behavior: 'smooth' });
            }));
        } catch (e) { /* no history yet */ }
    }

    function setStatus(msg, kind = '') {
        const el = document.getElementById('vlab-status');
        if (el) { el.textContent = msg || ''; el.className = 'vlab-status ' + kind; }
    }

    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    let selectedFile = null;

    function bind() {
        const fileInput = document.getElementById('vlab-file');
        const drop = document.getElementById('vlab-drop');
        drop.addEventListener('click', () => fileInput.click());
        drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
        drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
        drop.addEventListener('drop', e => {
            e.preventDefault(); drop.classList.remove('drag');
            if (e.dataTransfer.files[0]) { selectedFile = e.dataTransfer.files[0]; document.getElementById('vlab-file-name').textContent = selectedFile.name; }
        });
        fileInput.addEventListener('change', () => {
            if (fileInput.files[0]) { selectedFile = fileInput.files[0]; document.getElementById('vlab-file-name').textContent = selectedFile.name; }
        });
        document.getElementById('vlab-watch-btn').addEventListener('click', onWatch);
    }

    async function onWatch() {
        const urlVal = document.getElementById('vlab-url').value.trim();
        if (!selectedFile && !urlVal) { setStatus('Pick a file or paste a YouTube URL first.', 'err'); return; }
        document.getElementById('vlab-report').style.display = 'none';
        document.getElementById('vlab-obs').style.display = 'none';
        setStatus('🎥 Gemini is watching the video… (this can take 20–90s)', 'busy');
        const btn = document.getElementById('vlab-watch-btn');
        btn.disabled = true;
        try {
            let res;
            if (urlVal) {
                res = await fetch('/api/gemini/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: urlVal }) });
            } else {
                res = await fetch('/api/gemini/watch?name=' + encodeURIComponent(selectedFile.name), {
                    method: 'POST', headers: { 'Content-Type': selectedFile.type || 'video/mp4' }, body: selectedFile
                });
            }
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
            observations = data.observations; ytId = data.ytId || null; videoUrl = data.videoUrl || null;
            renderObservations(data.model);
            setStatus('✓ Watched. Now ask Optimusk Prime for data-backed advice.', 'ok');
        } catch (e) {
            setStatus('Watch failed: ' + e.message, 'err');
        } finally {
            btn.disabled = false;
        }
    }

    function renderObservations(model) {
        const o = observations || {};
        const el = document.getElementById('vlab-obs');
        const beats = Array.isArray(o.beats) ? o.beats.slice(0, 8).map(b => `<li><b>${esc(b.t_start)}–${esc(b.t_end)}s</b> ${esc(b.description)} <span class="vlab-pill">intensity ${esc(b.intensity_1to10)}</span></li>`).join('') : '';
        el.innerHTML = `
            <div class="vlab-section-title">👁 What Gemini saw <span class="vlab-model">${esc(model || '')}</span></div>
            <div class="vlab-obs-grid">
                <div><div class="vlab-k">Summary</div><div>${esc(o.summary)}</div></div>
                <div><div class="vlab-k">Hook (first 3s)</div><div>${esc(o.hook && o.hook.first_3s)} <span class="vlab-pill">strength ${esc(o.hook && o.hook.strength_1to10)}/10</span></div></div>
                <div><div class="vlab-k">Payoff</div><div>${esc(o.payoff && o.payoff.description)} ${o.payoff && o.payoff.exceeds_hook ? '<span class="vlab-pill good">exceeds hook</span>' : '<span class="vlab-pill warn">does not exceed hook</span>'}</div></div>
                <div><div class="vlab-k">Novelty / Clarity</div><div>${esc(o.novelty_1to10)}/10 · ${esc(o.clarity_1to10)}/10</div></div>
            </div>
            ${beats ? `<div class="vlab-k">Beats</div><ul class="vlab-beats">${beats}</ul>` : ''}
            <button id="vlab-advise-btn" class="vlab-btn primary">🧠 Get data-backed advice from Optimusk Prime</button>
        `;
        el.style.display = 'block';
        document.getElementById('vlab-advise-btn').addEventListener('click', onAdvise);
    }

    async function onAdvise() {
        const btn = document.getElementById('vlab-advise-btn');
        btn.disabled = true;
        setStatus('🧠 Optimusk Prime is cross-checking the indicators, experiments, and your analytics…', 'busy');
        try {
            const res = await fetch('/api/videolab/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ observations, ytId, videoUrl }) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
            jobId = data.jobId;
            pollAdvice();
        } catch (e) {
            setStatus('Advice request failed: ' + e.message, 'err');
            btn.disabled = false;
        }
    }

    function pollAdvice() {
        if (pollTimer) clearInterval(pollTimer);
        let waited = 0;
        const stepLabels = { gather_data: 'Gathering your indicators + analytics', coordinator_pass_1: 'Optimusk Prime drafting advice', coordinator_pass_2: 'Optimusk Prime self-critiquing the numbers' };
        pollTimer = setInterval(async () => {
            waited += 5;
            try {
                const res = await fetch('/api/videolab/advice/' + jobId);
                const data = await res.json();
                if (data.status === 'done' || data.status === 'done_unparsed' || data.status === 'error') {
                    clearInterval(pollTimer); pollTimer = null;
                    setStatus(data.status === 'error' ? ('Coordinator error: ' + (data.error || '')) : '✓ Analysis complete — everything saved.', data.status === 'error' ? 'err' : 'ok');
                    renderReport(data);
                } else {
                    const last = (data.steps || []).slice(-1)[0];
                    const lbl = last ? (stepLabels[last.name] || last.name) : 'starting';
                    setStatus(`🧠 ${lbl}… (${waited}s)`, 'busy');
                }
            } catch (e) { /* keep polling */ }
            if (waited >= 360) { clearInterval(pollTimer); pollTimer = null; setStatus('Still working — leave this open; it saves automatically.', ''); }
        }, 5000);
    }

    function renderLog(record) {
        const steps = (record.steps || []).map(s => {
            const body = s.text ? `<pre class="vlab-log-pre">${esc(s.text)}</pre>` : (s.error ? `<div class="vlab-log-err">${esc(s.error)}</div>` : (s.note ? `<div class="vlab-log-note">${esc(s.note)}</div>` : ''));
            return `<div class="vlab-log-step"><div class="vlab-log-name">${esc(s.name)} <span class="vlab-log-time">${esc((s.at || '').slice(11, 19))}</span>${s.usage ? `<span class="vlab-pill">${esc(s.usage.total)} tok</span>` : ''}</div>${body}</div>`;
        }).join('');
        const dp = record.dataPack || {};
        const dataUsed = `Indicator relevance (${(dp.top_experiments_by_correlation || []).length} top experiments), retention rules (${(dp.retention_design_rules || []).length}), corpus benchmarks across ${esc(dp.corpus_size)} videos, ${record.videoContext && record.videoContext.brain ? 'TRIBE brain present' : 'no brain analysis for this video'}.`;
        const transcript = record.sessionTranscript ? `<details class="vlab-details"><summary>Optimusk Prime full session transcript (.jsonl)</summary><pre class="vlab-log-pre">${esc(record.sessionTranscript.slice(0, 20000))}</pre></details>` : '';
        const obs = record.observations ? `<details class="vlab-details"><summary>What Gemini saw (raw)</summary><pre class="vlab-log-pre">${esc(JSON.stringify(record.observations, null, 2).slice(0, 8000))}</pre></details>` : '';
        return `<details class="vlab-details vlab-log"><summary>🔍 How Optimusk Prime reasoned — saved (data used, both passes, transcript)</summary>
            <div class="vlab-log-data">📊 ${dataUsed}</div>
            ${steps}
            ${obs}
            ${transcript}
        </details>`;
    }

    const fmtT = s => (s == null || isNaN(s)) ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

    function renderPlayer(record, tips, duration) {
        const vurl = record.videoUrl;
        if (!vurl) return '';
        const o = record.observations || {};
        const dur = duration || o.duration_seconds || 0;
        const beats = (Array.isArray(o.beats) ? o.beats : []).filter(b => dur > 0 && b.t_start != null);
        const beatHtml = beats.map(b => {
            const L = Math.max(0, Math.min(100, (b.t_start / dur) * 100));
            const W = Math.max(0.5, Math.min(100 - L, (((b.t_end || b.t_start + 1) - b.t_start) / dur) * 100));
            return `<div class="vlab-tl-beat" style="left:${L}%;width:${W}%" title="${esc(b.description || '')}"></div>`;
        }).join('');
        const markers = tips.filter(t => dur > 0 && t.timestamp_start != null && !isNaN(t.timestamp_start)).map(t => {
            const L = Math.max(0, Math.min(100, (t.timestamp_start / dur) * 100));
            return `<div class="vlab-tl-marker" style="left:${L}%" data-ts="${t.timestamp_start}" data-rank="${esc(t.rank)}" title="${esc(t.tip)}"><div class="vlab-tl-dot">${esc(t.rank)}</div><div class="vlab-tl-stem"></div></div>`;
        }).join('');
        return `<div class="vlab-player-wrap">
            <video class="vlab-video" id="vlab-video" src="${esc(vurl)}" controls preload="metadata"></video>
            <div class="vlab-timeline" id="vlab-timeline">
                <div class="vlab-tl-beats">${beatHtml}</div>
                ${markers}
                <div class="vlab-tl-playhead" id="vlab-playhead" style="left:0%"></div>
            </div>
            <div class="vlab-tl-labels"><span>0:00</span><span>${fmtT(dur)} · markers = the tips below, shaded = scene beats</span></div>
        </div>`;
    }

    function renderReport(record) {
        const a = record.advice || {};
        const el = document.getElementById('vlab-report');
        const tips = Array.isArray(a.tips) ? a.tips : [];
        const duration = (record.observations && record.observations.duration_seconds) || 0;
        const tipHtml = tips.map(t => {
            const ev = t.evidence || {};
            const ts = (t.timestamp_start != null && !isNaN(t.timestamp_start))
                ? `<span class="vlab-tip-ts" data-ts="${t.timestamp_start}">⏱ ${fmtT(t.timestamp_start)}${t.timestamp_end != null ? '–' + fmtT(t.timestamp_end) : ''} ▶</span>` : '';
            return `<div class="vlab-tip" id="vlab-tip-${esc(t.rank)}">
                <div class="vlab-tip-rank">${esc(t.rank)}</div>
                <div class="vlab-tip-body">
                    <div class="vlab-tip-title">${esc(t.tip)} ${ts}</div>
                    ${t.change ? `<div class="vlab-tip-change">▶ ${esc(t.change)}</div>` : ''}
                    ${t.why ? `<div class="vlab-tip-why"><b>Logic:</b> ${esc(t.why)}</div>` : ''}
                    <div class="vlab-tip-evidence">
                        ${ev.indicator ? `<span class="vlab-ev">📊 ${esc(ev.indicator)}${ev.r_or_weight != null ? ` (${esc(ev.r_or_weight)})` : ''}</span>` : ''}
                        ${ev.source ? `<span class="vlab-ev-src">${esc(ev.source)}</span>` : ''}
                        ${t.expectedImpact ? `<span class="vlab-ev impact">⤴ ${esc(t.expectedImpact)}</span>` : ''}
                        ${t.brainAlignment ? `<span class="vlab-ev brain">🧠 ${esc(t.brainAlignment)}</span>` : ''}
                    </div>
                </div>
            </div>`;
        }).join('');
        const unparsed = !record.advice && record.finalText
            ? `<div class="vlab-summary">Optimusk Prime answered, but not as clean JSON — raw reply below (still fully saved):</div><pre class="vlab-log-pre">${esc(record.finalText.slice(0, 6000))}</pre>` : '';
        el.innerHTML = `
            <div class="vlab-section-title">📈 Improvement plan${record.videoTitle ? ' — ' + esc(record.videoTitle) : ''}</div>
            ${renderPlayer(record, tips, duration)}
            <div class="vlab-score-row">
                ${a.overallScore != null ? `<div class="vlab-score"><div class="vlab-score-num">${esc(a.overallScore)}</div><div class="vlab-score-lbl">overall / 100</div></div>` : ''}
                ${a.vsCorpus ? `<div class="vlab-vscorpus"><div class="vlab-k">vs. your high-view corpus</div><div>${esc(a.vsCorpus)}</div></div>` : ''}
            </div>
            ${a.summary ? `<div class="vlab-summary">${esc(a.summary)}</div>` : ''}
            <div class="vlab-tips">${tipHtml || (unparsed ? '' : '<div class="vlab-empty">No tips returned.</div>')}</div>
            ${unparsed}
            ${renderLog(record)}`;
        el.style.display = 'block';
        wireTimeline(duration);
    }

    function wireTimeline(duration) {
        const video = document.getElementById('vlab-video');
        if (!video) return;
        const playhead = document.getElementById('vlab-playhead');
        const seekTo = (ts) => { try { video.currentTime = Number(ts); video.play().catch(() => {}); video.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {} };
        const highlight = (rank) => { document.querySelectorAll('.vlab-tip').forEach(n => n.classList.remove('active')); const el = document.getElementById('vlab-tip-' + rank); if (el) el.classList.add('active'); };
        document.querySelectorAll('.vlab-tl-marker').forEach(m => m.addEventListener('click', () => { seekTo(m.dataset.ts); highlight(m.dataset.rank); }));
        document.querySelectorAll('.vlab-tip-ts').forEach(s => s.addEventListener('click', () => seekTo(s.dataset.ts)));
        video.addEventListener('timeupdate', () => {
            const dur = video.duration || duration || 0;
            if (dur > 0 && playhead) playhead.style.left = Math.min(100, (video.currentTime / dur) * 100) + '%';
        });
    }

    return {
        open(bodyEl) {
            container = bodyEl;
            container.innerHTML = render();
            observations = null; ytId = null; jobId = null; selectedFile = null; videoUrl = null;
            bind();
            loadHistory();
        },
        close() {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            container = null; observations = null; jobId = null; selectedFile = null;
        }
    };
})();

if (typeof BuildingRegistry !== 'undefined') {
    BuildingRegistry.register('Video Lab', {
        open: (bodyEl) => VideoLabUI.open(bodyEl),
        close: () => VideoLabUI.close()
    });
}
