/* ── Video Generation Building ── 0.00001% multi-model studio ── */
const VideoUI = (() => {
    // Module is rendered into jarvis-ui content; expose render() + bindEvents()
    let container = null;

    // ── State ──
    let modelsCatalog = null;            // [{ id, label, endpoint, … }]
    let modelsKeyConfigured = false;
    let modelsLoading = false;
    let modelsError = null;

    let concept = '';
    let conceptDuration = 30;
    let conceptStyle = 'Cinematic';
    let conceptCharacters = '';
    let storyboardLoading = false;
    let storyboardError = null;

    let shots = [];                      // [{ id, prompt, durationSeconds, model, cameraAngle, audioMode, notes, referenceImageUrl, status, jobId, videoUrl, progress, error }]
    let activeShotId = null;             // currently-previewed shot

    let globalParams = {
        quality: 'high',
        seed: '',
        guidanceScale: 7.5,
        motionIntensity: 'medium',
        characterStrength: 0.7,
        negativePrompt: '',
        outputFormat: 'mp4',
        resolution: '1080p',
        fps: 30,
        // model-specific
        audioPrompt: '',
        safetyFilter: true,
        cameraMovement: 'static',
        referenceVideoUrl: '',
    };

    let characterPack = {
        description: '',
        images: [],                      // data URLs (base64) — sent as ingredients
    };

    let assembledVideoUrl = null;
    let assembleLoading = false;
    let assembleError = null;

    let pollTimers = {};                 // shotId → interval handle

    // ── Helpers ──
    function uid() { return 's' + Math.random().toString(36).slice(2, 8); }
    function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    function getModel(id) { return (modelsCatalog || []).find(m => m.id === id); }
    function pricePerSecond(modelId, audioOn) {
        const m = getModel(modelId);
        if (!m) return 0;
        return audioOn && m.audioCapable ? m.pricePerSecondAudio : m.pricePerSecondNoAudio;
    }
    function shotCost(shot) {
        const audio = shot.audioMode === 'on';
        return pricePerSecond(shot.model, audio) * (Number(shot.durationSeconds) || 0);
    }
    function totalCost() {
        return shots.reduce((sum, s) => sum + shotCost(s), 0);
    }

    // ── Sample storyboard so the UI is usable without a live generation ──
    function makeSampleStoryboard() {
        return [
            { id: uid(), shotNumber: 1, prompt: 'Macro close-up of an indestructible egg held between two fingers — soft rim light, jet-black background, dust motes floating, studio cinematic.', durationSeconds: 4, model: 'veo3', cameraAngle: 'Close-up', audioMode: 'on', notes: 'Hook — silent buildup', status: 'idle' },
            { id: uid(), shotNumber: 2, prompt: 'Slow-motion hammer descending toward the egg on a steel anvil; sparks fly as metal meets shell, egg unscathed.', durationSeconds: 5, model: 'kling-2.6-pro', cameraAngle: 'Wide', audioMode: 'on', notes: 'Action shot — dramatic impact', status: 'idle' },
            { id: uid(), shotNumber: 3, prompt: 'Overhead shot of egg in a hydraulic press; press descends and lifts back up, egg spins lazily.', durationSeconds: 5, model: 'wan-2.6', cameraAngle: 'Overhead', audioMode: 'off', notes: 'B-roll — keep cheap', status: 'idle' },
            { id: uid(), shotNumber: 4, prompt: 'Hand picking up the unbroken egg, walking past a graveyard of crushed normal eggs on a polished black surface.', durationSeconds: 4, model: 'veo3', cameraAngle: 'Medium', audioMode: 'on', notes: 'Payoff', status: 'idle' },
        ];
    }

    // ── API ──
    async function loadModels(force) {
        if (modelsCatalog && !force) return;
        modelsLoading = true;
        try {
            const r = await fetch('/api/video/models');
            const j = await r.json();
            modelsCatalog = j.models || [];
            modelsKeyConfigured = !!j.keyConfigured;
        } catch (e) {
            modelsError = e.message;
        } finally {
            modelsLoading = false;
            refresh();
        }
    }

    async function generateStoryboard() {
        if (!concept.trim()) { storyboardError = 'Add a concept first'; refresh(); return; }
        storyboardLoading = true; storyboardError = null; refresh();
        try {
            const r = await fetch('/api/video/storyboard', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    concept,
                    duration: conceptDuration,
                    style: conceptStyle,
                    characters: conceptCharacters,
                }),
            });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            shots = (j.shots || []).map(s => ({
                id: uid(),
                shotNumber: s.shotNumber,
                prompt: s.prompt || '',
                durationSeconds: Math.max(1, Math.min(10, Number(s.durationSeconds) || 4)),
                model: s.recommendedModel && getModel(s.recommendedModel) ? s.recommendedModel : 'kling-2.6-pro',
                cameraAngle: s.cameraAngle || 'Medium',
                audioMode: s.audioMode || 'off',
                notes: s.notes || '',
                referenceImageUrl: '',
                status: 'idle',
            }));
        } catch (e) {
            storyboardError = e.message;
        } finally {
            storyboardLoading = false;
            refresh();
        }
    }

    async function generateShot(shotId) {
        const shot = shots.find(s => s.id === shotId);
        if (!shot) return;
        shot.status = 'submitting'; shot.error = null; shot.progress = 0; refresh();
        try {
            const ingredients = (characterPack.images || []).slice(0, 3);
            const params = {};
            const m = getModel(shot.model);
            if (m && m.featureFlags) {
                if (m.featureFlags.includes('audioPrompt') && globalParams.audioPrompt) params.audio_prompt = globalParams.audioPrompt;
                if (m.featureFlags.includes('safetyFilter')) params.safety_filter = !!globalParams.safetyFilter;
                if (m.featureFlags.includes('cameraMovement') && globalParams.cameraMovement) params.camera_movement = globalParams.cameraMovement;
                if (m.featureFlags.includes('referenceVideo') && globalParams.referenceVideoUrl) params.reference_video_url = globalParams.referenceVideoUrl;
            }
            if (globalParams.seed) params.seed = Number(globalParams.seed);
            if (globalParams.guidanceScale) params.guidance_scale = Number(globalParams.guidanceScale);
            if (globalParams.negativePrompt) params.negative_prompt = globalParams.negativePrompt;
            if (globalParams.resolution) params.resolution = globalParams.resolution;
            if (globalParams.fps) params.fps = Number(globalParams.fps);
            params.motion_intensity = globalParams.motionIntensity;
            params.character_consistency = Number(globalParams.characterStrength);
            params.quality = globalParams.quality;

            const r = await fetch('/api/video/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: shot.model,
                    prompt: shot.prompt,
                    imageUrl: shot.referenceImageUrl || undefined,
                    durationSeconds: shot.durationSeconds,
                    aspectRatio: '9:16',
                    parameters: params,
                    ingredients: ingredients.length ? ingredients : undefined,
                }),
            });
            const j = await r.json();
            if (!r.ok) {
                shot.status = j.needsTopUp ? 'needs_top_up' : 'failed';
                shot.error = j.error || `HTTP ${r.status}`;
                shot.billingUrl = j.billingUrl;
                refresh();
                return;
            }
            shot.jobId = j.jobId;
            shot.status = 'queued';
            refresh();
            startPolling(shot.id);
        } catch (e) {
            shot.status = 'failed';
            shot.error = e.message;
            refresh();
        }
    }

    function startPolling(shotId) {
        if (pollTimers[shotId]) clearInterval(pollTimers[shotId]);
        pollTimers[shotId] = setInterval(async () => {
            const shot = shots.find(s => s.id === shotId);
            if (!shot || !shot.jobId) { clearInterval(pollTimers[shotId]); delete pollTimers[shotId]; return; }
            try {
                const r = await fetch(`/api/video/status/${encodeURIComponent(shot.jobId)}?model=${encodeURIComponent(shot.model)}`);
                const j = await r.json();
                if (j.status === 'COMPLETED' && j.videoUrl) {
                    shot.status = 'complete';
                    shot.videoUrl = j.videoUrl;
                    shot.progress = 100;
                    clearInterval(pollTimers[shotId]); delete pollTimers[shotId];
                } else if (j.status === 'FAILED' || j.status === 'ERROR') {
                    shot.status = 'failed';
                    shot.error = j.error || 'fal.ai reported failure';
                    clearInterval(pollTimers[shotId]); delete pollTimers[shotId];
                } else {
                    shot.status = 'running';
                    if (typeof j.progress === 'number') shot.progress = j.progress;
                }
                refresh();
            } catch {}
        }, 4000);
    }

    async function generateAllShots() {
        for (const s of shots) {
            if (s.status === 'idle' || s.status === 'failed' || s.status === 'needs_top_up') {
                await generateShot(s.id);
                await new Promise(r => setTimeout(r, 400));
            }
        }
    }

    async function assembleFinalVideo() {
        const ready = shots.filter(s => s.status === 'complete' && s.videoUrl);
        if (!ready.length) { assembleError = 'No completed shots to assemble'; refresh(); return; }
        assembleLoading = true; assembleError = null; refresh();
        try {
            const r = await fetch('/api/video/assemble', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shots: ready.map(s => ({ videoUrl: s.videoUrl })),
                    outputFormat: globalParams.outputFormat,
                }),
            });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            assembledVideoUrl = j.videoUrl;
        } catch (e) {
            assembleError = e.message;
        } finally {
            assembleLoading = false;
            refresh();
        }
    }

    async function sendToTribe(videoUrl) {
        if (!videoUrl) return;
        alert('TRIBE analysis hook: would post ' + videoUrl + ' to /api/tribe/analyze.\nFor now, save the video to video_data/<id>/video.mp4 and run the Brain tab.');
    }

    async function scoreWithHookModel(shot) {
        if (!shot || !shot.prompt) return;
        try {
            const r = await fetch('/api/jarvis/hook-model/score-v2', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hook: shot.prompt, wps: 2.5 }),
            });
            const j = await r.json();
            const score = j.score || j.prediction || JSON.stringify(j);
            alert('Hook Model V2 score:\n' + score);
        } catch (e) {
            alert('Hook scoring failed: ' + e.message);
        }
    }

    // ── Top-level render entry called by jarvis-ui ──
    function render() {
        if (!modelsCatalog && !modelsLoading) loadModels();
        // Seed sample storyboard so Tyler always sees a populated UI
        if (!shots.length) shots = makeSampleStoryboard();
        setTimeout(bindEvents, 30);
        return `<div class="video-root">${renderBody()}</div>`;
    }

    function refresh() {
        if (!container) return;
        const root = container.querySelector('.video-root');
        if (!root) return;
        root.innerHTML = renderBody();
        bindEvents();
    }

    // ── Body ──
    function renderBody() {
        const banner = renderTopUpBanner();
        return `
            <div style="display:flex;flex-direction:column;gap:14px">
                ${banner}
                ${renderHeader()}
                <div style="display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:14px;align-items:start">
                    <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
                        ${renderConceptPanel()}
                        ${renderCharacterPack()}
                        ${renderStoryboardPanel()}
                        ${renderQueuePanel()}
                        ${renderOutputPanel()}
                    </div>
                    <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
                        ${renderParametersPanel()}
                    </div>
                </div>
            </div>
        `;
    }

    function renderHeader() {
        return `
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap">
                <div>
                    <div style="font-size:18px;font-weight:700;color:#f1f5f9">🎬 Video Generation Studio</div>
                    <div style="font-size:11px;color:#94a3b8;margin-top:3px;max-width:680px;line-height:1.5">
                        0.00001% workflow: storyboard → per-shot generation (best model per shot) → MMAudio ambient → assembly.
                        Fal.ai-backed with full parameter control.
                    </div>
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                    <span style="background:#1e293b;color:#cbd5e1;padding:2px 8px;border-radius:4px;font-size:10px">${shots.length} shots</span>
                    <span style="background:#facc1522;color:#facc15;padding:2px 8px;border-radius:4px;font-size:10px">$${totalCost().toFixed(2)} est.</span>
                    <span style="background:${modelsKeyConfigured ? '#22c55e22' : '#f8717122'};color:${modelsKeyConfigured ? '#22c55e' : '#f87171'};padding:2px 8px;border-radius:4px;font-size:10px">
                        ${modelsKeyConfigured ? 'fal.ai key ✓' : 'fal.ai key missing'}
                    </span>
                </div>
            </div>
        `;
    }

    function renderTopUpBanner() {
        // Always-present hint about billing — fal.ai balance is exhausted today
        return `
            <div style="background:#fef3c722;border:1px solid #facc15;border-left:4px solid #facc15;padding:10px 14px;border-radius:6px;font-size:12px;color:#fde68a;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
                <div>
                    ⚠️ <strong>fal.ai balance exhausted</strong> — UI is fully functional, but generation will return 403 until you top up.
                </div>
                <a href="https://fal.ai/dashboard/billing" target="_blank" style="background:#facc15;color:#0a0f1e;padding:4px 10px;border-radius:4px;font-weight:700;text-decoration:none;font-size:11px">Top up at fal.ai/dashboard/billing →</a>
            </div>
        `;
    }

    // ── Panel A: Concept Input ──
    function renderConceptPanel() {
        return `
            <div style="background:#0d1525;border:1px solid #1e293b;border-radius:8px;padding:14px">
                <div style="font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;margin-bottom:10px">A · Concept</div>
                <textarea id="video-concept" placeholder="What video do you want to create? (be specific — characters, setting, hook, payoff)" style="width:100%;min-height:80px;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:4px;padding:8px 10px;font-size:12px;font-family:inherit;resize:vertical;box-sizing:border-box">${escapeHtml(concept)}</textarea>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:10px">
                    <div>
                        <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Duration: <span id="video-duration-label">${conceptDuration}s</span></div>
                        <input id="video-duration" type="range" min="15" max="120" step="5" value="${conceptDuration}" style="width:100%">
                    </div>
                    <div>
                        <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Style</div>
                        <select id="video-style" style="width:100%;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:4px;padding:6px 8px;font-size:12px">
                            ${['Cinematic','Documentary','Action','Dialogue','B-roll'].map(s => `<option ${conceptStyle === s ? 'selected' : ''}>${s}</option>`).join('')}
                        </select>
                    </div>
                    <div style="grid-column:1/-1">
                        <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Characters (text description)</div>
                        <input id="video-characters" type="text" value="${escapeHtml(conceptCharacters)}" placeholder="e.g. one bearded scientist in a lab coat" style="width:100%;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:4px;padding:6px 8px;font-size:12px;box-sizing:border-box">
                    </div>
                </div>
                <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                    <button id="video-storyboard-btn" style="background:#facc15;color:#0a0f1e;border:0;border-radius:4px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer">${storyboardLoading ? 'Generating storyboard…' : 'Generate Storyboard'}</button>
                    ${storyboardError ? `<span style="color:#f87171;font-size:11px">${escapeHtml(storyboardError)}</span>` : ''}
                </div>
            </div>
        `;
    }

    // ── Character Pack ──
    function renderCharacterPack() {
        const locked = !!(characterPack.description.trim() || characterPack.images.length);
        return `
            <div style="background:#0d1525;border:1px solid #1e293b;border-radius:8px;padding:14px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                    <div style="font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#64748b">Character Pack</div>
                    ${locked ? '<span style="background:#22d3ee22;color:#22d3ee;padding:2px 8px;border-radius:4px;font-size:10px">Character locked</span>' : ''}
                </div>
                <textarea id="video-char-desc" placeholder="Describe the character (passed to every shot)" style="width:100%;min-height:50px;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:4px;padding:6px 10px;font-size:11px;font-family:inherit;resize:vertical;box-sizing:border-box">${escapeHtml(characterPack.description)}</textarea>
                <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
                    <input id="video-char-files" type="file" accept="image/*" multiple style="font-size:11px;color:#94a3b8">
                    <span style="font-size:10px;color:#475569">${characterPack.images.length} reference image(s) · sent as ingredients to Veo 3 / Wan 2.6</span>
                </div>
            </div>
        `;
    }

    // ── Panel B: Storyboard ──
    function renderStoryboardPanel() {
        if (!shots.length) {
            return `<div style="background:#0d1525;border:1px solid #1e293b;border-radius:8px;padding:14px;color:#64748b;font-size:12px">B · Storyboard — empty. Generate above to populate.</div>`;
        }
        const cards = shots.map((s, idx) => renderShotCard(s, idx)).join('');
        return `
            <div style="background:#0d1525;border:1px solid #1e293b;border-radius:8px;padding:14px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">
                    <div style="font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#64748b">B · Storyboard (${shots.length} shots · ${shots.reduce((s, x) => s + (Number(x.durationSeconds) || 0), 0)}s total)</div>
                    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                        <span style="font-size:11px;color:#facc15;font-weight:700">$${totalCost().toFixed(2)}</span>
                        <button id="video-generate-all" style="background:#22d3ee;color:#0a0f1e;border:0;border-radius:4px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer">Generate All Shots</button>
                    </div>
                </div>
                <div style="display:flex;flex-direction:column;gap:10px">${cards}</div>
            </div>
        `;
    }

    function renderShotCard(shot, idx) {
        const m = getModel(shot.model);
        const cost = shotCost(shot);
        const status = shot.status || 'idle';
        const statusColor = status === 'complete' ? '#22c55e'
            : status === 'failed' ? '#f87171'
            : status === 'needs_top_up' ? '#facc15'
            : status === 'running' || status === 'queued' || status === 'submitting' ? '#22d3ee' : '#64748b';
        const modelButtons = (modelsCatalog || []).map(mod => `
            <button data-shot="${shot.id}" data-model="${mod.id}" class="vg-model-pick" style="background:${shot.model === mod.id ? '#facc15' : '#020617'};color:${shot.model === mod.id ? '#0a0f1e' : '#cbd5e1'};border:1px solid #1e293b;border-radius:4px;padding:3px 8px;font-size:10px;cursor:pointer;font-weight:${shot.model === mod.id ? '700' : '500'}">
                ${mod.badge || ''} ${escapeHtml(mod.label)}
            </button>
        `).join('');
        const previewBox = shot.videoUrl
            ? `<video src="${escapeHtml(shot.videoUrl)}" controls style="width:100%;max-height:160px;border-radius:4px;background:#020617"></video>`
            : `<div style="width:100%;height:120px;background:#020617;border:1px dashed #1e293b;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#475569;font-size:11px">${status === 'idle' ? 'Not generated yet' : status === 'running' ? `Running… ${shot.progress || 0}%` : status === 'queued' ? 'In queue…' : status === 'failed' ? `Failed: ${escapeHtml(shot.error || '')}` : status === 'needs_top_up' ? '⚠ fal.ai balance exhausted' : 'Submitting…'}</div>`;
        return `
            <div style="background:#060d1a;border:1px solid #1e293b;border-radius:6px;padding:12px;display:grid;grid-template-columns:160px minmax(0,1fr);gap:12px;align-items:flex-start">
                <div style="display:flex;flex-direction:column;gap:6px">
                    <div style="font-size:11px;color:#94a3b8;font-weight:700">Shot ${idx + 1}</div>
                    ${previewBox}
                    <div style="display:flex;gap:4px">
                        <button data-shot-up="${shot.id}" style="flex:1;background:#0d1525;color:#cbd5e1;border:1px solid #1e293b;border-radius:3px;padding:2px 0;font-size:10px;cursor:pointer">↑</button>
                        <button data-shot-down="${shot.id}" style="flex:1;background:#0d1525;color:#cbd5e1;border:1px solid #1e293b;border-radius:3px;padding:2px 0;font-size:10px;cursor:pointer">↓</button>
                        <button data-shot-del="${shot.id}" style="flex:1;background:#0d1525;color:#f87171;border:1px solid #1e293b;border-radius:3px;padding:2px 0;font-size:10px;cursor:pointer">✕</button>
                    </div>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;min-width:0">
                    <textarea data-shot-prompt="${shot.id}" style="width:100%;min-height:50px;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:4px;padding:6px 8px;font-size:11px;font-family:inherit;resize:vertical;box-sizing:border-box">${escapeHtml(shot.prompt)}</textarea>
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px">
                        <label style="font-size:10px;color:#94a3b8">Duration: <span data-shot-dur-label="${shot.id}">${shot.durationSeconds}s</span>
                            <input data-shot-dur="${shot.id}" type="range" min="1" max="10" value="${shot.durationSeconds}" style="width:100%">
                        </label>
                        <label style="font-size:10px;color:#94a3b8">Camera
                            <select data-shot-cam="${shot.id}" style="width:100%;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:3px;padding:3px 4px;font-size:11px">
                                ${['Wide','Medium','Close-up','POV','Overhead'].map(c => `<option ${shot.cameraAngle === c ? 'selected' : ''}>${c}</option>`).join('')}
                            </select>
                        </label>
                        <label style="font-size:10px;color:#94a3b8">Audio
                            <select data-shot-audio="${shot.id}" style="width:100%;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:3px;padding:3px 4px;font-size:11px">
                                <option value="on" ${shot.audioMode === 'on' ? 'selected' : ''}>On</option>
                                <option value="off" ${shot.audioMode === 'off' ? 'selected' : ''}>Off</option>
                            </select>
                        </label>
                        <label style="font-size:10px;color:#94a3b8">Reference image
                            <input data-shot-ref="${shot.id}" type="file" accept="image/*" style="width:100%;font-size:10px;color:#94a3b8">
                        </label>
                    </div>
                    <div style="display:flex;gap:4px;flex-wrap:wrap">${modelButtons}</div>
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
                        <div style="font-size:10px;color:#94a3b8">
                            ${m ? `${escapeHtml(m.label)} · $${pricePerSecond(shot.model, shot.audioMode === 'on').toFixed(3)}/s · ` : ''}<strong style="color:#facc15">$${cost.toFixed(3)}</strong>
                            <span style="margin-left:8px;color:${statusColor}">● ${escapeHtml(status)}</span>
                        </div>
                        <button data-shot-gen="${shot.id}" style="background:#22d3ee;color:#0a0f1e;border:0;border-radius:4px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer">Generate This Shot</button>
                    </div>
                    ${shot.notes ? `<div style="font-size:10px;color:#64748b;font-style:italic">${escapeHtml(shot.notes)}</div>` : ''}
                </div>
            </div>
        `;
    }

    // ── Panel C: Generation Queue + Preview ──
    function renderQueuePanel() {
        const live = shots.filter(s => s.status === 'running' || s.status === 'queued' || s.status === 'submitting');
        const done = shots.filter(s => s.status === 'complete');
        if (!live.length && !done.length) return '';
        return `
            <div style="background:#0d1525;border:1px solid #1e293b;border-radius:8px;padding:14px">
                <div style="font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;margin-bottom:10px">C · Generation Queue</div>
                ${live.length ? `<div style="margin-bottom:10px">${live.map(s => `
                    <div style="display:flex;justify-content:space-between;font-size:11px;color:#cbd5e1;padding:4px 0;border-bottom:1px solid #1e293b">
                        <span>Shot ${shots.indexOf(s) + 1} · ${escapeHtml(getModel(s.model)?.label || s.model)}</span>
                        <span style="color:#22d3ee">${escapeHtml(s.status)} ${s.progress != null ? '· ' + s.progress + '%' : ''}</span>
                    </div>`).join('')}</div>` : ''}
                ${done.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px">${done.map(s => `
                    <div style="background:#020617;border:1px solid #1e293b;border-radius:4px;padding:6px">
                        <video src="${escapeHtml(s.videoUrl)}" controls style="width:100%;max-height:140px;border-radius:3px"></video>
                        <div style="font-size:10px;color:#94a3b8;margin-top:4px">Shot ${shots.indexOf(s) + 1} · ${s.durationSeconds}s</div>
                    </div>`).join('')}</div>` : ''}
                ${done.length === shots.length && shots.length > 0 ? `
                    <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                        <button id="video-assemble" style="background:#facc15;color:#0a0f1e;border:0;border-radius:4px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer">${assembleLoading ? 'Assembling…' : 'Assemble Final Video'}</button>
                        ${assembleError ? `<span style="color:#f87171;font-size:11px">${escapeHtml(assembleError)}</span>` : ''}
                    </div>` : ''}
            </div>
        `;
    }

    // ── Panel E: Output + History ──
    function renderOutputPanel() {
        if (!assembledVideoUrl) return '';
        return `
            <div style="background:#0d1525;border:1px solid #1e293b;border-radius:8px;padding:14px">
                <div style="font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;margin-bottom:10px">E · Final Output</div>
                <video src="${escapeHtml(assembledVideoUrl)}" controls style="width:100%;max-height:360px;border-radius:6px;background:#020617"></video>
                <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
                    <a href="${escapeHtml(assembledVideoUrl)}" download style="background:#22d3ee;color:#0a0f1e;border:0;border-radius:4px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;text-decoration:none">⬇ Download</a>
                    <button id="video-send-tribe" style="background:#7c3aed;color:#fff;border:0;border-radius:4px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer">→ Analyze with TRIBE</button>
                    <button id="video-score-hook" style="background:#a855f7;color:#fff;border:0;border-radius:4px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer">→ Score Hook</button>
                </div>
            </div>
        `;
    }

    // ── Panel D: Parameters (right sidebar) ──
    function renderParametersPanel() {
        // Determine which model-specific knobs to show based on the most-used model in the storyboard
        const modelCounts = {};
        shots.forEach(s => { modelCounts[s.model] = (modelCounts[s.model] || 0) + 1; });
        const dominantModel = Object.keys(modelCounts).sort((a, b) => modelCounts[b] - modelCounts[a])[0];
        const flags = (getModel(dominantModel) || {}).featureFlags || [];
        return `
            <div style="background:#0d1525;border:1px solid #1e293b;border-radius:8px;padding:14px;position:sticky;top:8px">
                <div style="font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;margin-bottom:10px">D · Parameters</div>
                <div style="display:flex;flex-direction:column;gap:10px;font-size:11px;color:#94a3b8">
                    <label>Quality
                        <select id="vp-quality" style="width:100%;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:3px;padding:4px 6px;font-size:11px">
                            ${['standard','high','ultra'].map(q => `<option ${globalParams.quality === q ? 'selected' : ''}>${q}</option>`).join('')}
                        </select>
                    </label>
                    <label>Seed
                        <input id="vp-seed" type="number" value="${escapeHtml(globalParams.seed)}" placeholder="random" style="width:100%;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:3px;padding:4px 6px;font-size:11px;box-sizing:border-box">
                    </label>
                    <label>Guidance scale: <span id="vp-guidance-label">${globalParams.guidanceScale}</span>
                        <input id="vp-guidance" type="range" min="0" max="20" step="0.5" value="${globalParams.guidanceScale}" style="width:100%">
                    </label>
                    <label>Motion intensity
                        <select id="vp-motion" style="width:100%;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:3px;padding:4px 6px;font-size:11px">
                            ${['low','medium','high'].map(m => `<option ${globalParams.motionIntensity === m ? 'selected' : ''}>${m}</option>`).join('')}
                        </select>
                    </label>
                    <label>Character consistency: <span id="vp-char-label">${globalParams.characterStrength.toFixed(2)}</span>
                        <input id="vp-char" type="range" min="0" max="1" step="0.05" value="${globalParams.characterStrength}" style="width:100%">
                    </label>
                    <label>Negative prompt
                        <textarea id="vp-negative" style="width:100%;min-height:40px;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:3px;padding:4px 6px;font-size:11px;font-family:inherit;resize:vertical;box-sizing:border-box">${escapeHtml(globalParams.negativePrompt)}</textarea>
                    </label>
                    <label>Output format
                        <select id="vp-format" style="width:100%;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:3px;padding:4px 6px;font-size:11px">
                            <option ${globalParams.outputFormat === 'mp4' ? 'selected' : ''}>mp4</option>
                            <option ${globalParams.outputFormat === 'webm' ? 'selected' : ''}>webm</option>
                        </select>
                    </label>
                    <label>Resolution
                        <select id="vp-resolution" style="width:100%;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:3px;padding:4px 6px;font-size:11px">
                            ${['480p','720p','1080p'].map(r => `<option ${globalParams.resolution === r ? 'selected' : ''}>${r}</option>`).join('')}
                        </select>
                    </label>
                    <label>Frame rate
                        <select id="vp-fps" style="width:100%;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:3px;padding:4px 6px;font-size:11px">
                            <option value="24" ${globalParams.fps == 24 ? 'selected' : ''}>24 fps</option>
                            <option value="30" ${globalParams.fps == 30 ? 'selected' : ''}>30 fps</option>
                        </select>
                    </label>
                    ${flags.includes('audioPrompt') ? `<label style="border-top:1px solid #1e293b;padding-top:8px">Audio prompt (Veo 3)
                        <textarea id="vp-audio-prompt" style="width:100%;min-height:30px;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:3px;padding:4px 6px;font-size:11px;resize:vertical;box-sizing:border-box;font-family:inherit">${escapeHtml(globalParams.audioPrompt)}</textarea>
                    </label>` : ''}
                    ${flags.includes('safetyFilter') ? `<label style="display:flex;align-items:center;gap:6px"><input id="vp-safety" type="checkbox" ${globalParams.safetyFilter ? 'checked' : ''}> Safety filter (Veo 3)</label>` : ''}
                    ${flags.includes('cameraMovement') ? `<label>Camera movement (Kling)
                        <select id="vp-camera-move" style="width:100%;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:3px;padding:4px 6px;font-size:11px">
                            ${['static','pan-left','pan-right','tilt-up','tilt-down','dolly-in','dolly-out','orbit'].map(c => `<option ${globalParams.cameraMovement === c ? 'selected' : ''}>${c}</option>`).join('')}
                        </select>
                    </label>` : ''}
                    ${flags.includes('referenceVideo') ? `<label>Reference video URL (Wan 2.6)
                        <input id="vp-ref-video" type="text" value="${escapeHtml(globalParams.referenceVideoUrl)}" placeholder="https://…/ref.mp4" style="width:100%;background:#020617;color:#e2e8f0;border:1px solid #1e293b;border-radius:3px;padding:4px 6px;font-size:11px;box-sizing:border-box">
                    </label>` : ''}
                    <div style="border-top:1px solid #1e293b;padding-top:8px;font-size:10px;color:#475569;line-height:1.5">
                        Pricing per model is shown on each shot. Model-specific knobs above appear based on the dominant model in your storyboard.
                    </div>
                </div>
            </div>
        `;
    }

    // ── Event binding ──
    function bindEvents() {
        if (!container) return;

        const concEl = container.querySelector('#video-concept');
        if (concEl) concEl.oninput = e => { concept = e.target.value; };
        const durEl = container.querySelector('#video-duration');
        if (durEl) durEl.oninput = e => {
            conceptDuration = Number(e.target.value);
            const lbl = container.querySelector('#video-duration-label');
            if (lbl) lbl.textContent = conceptDuration + 's';
        };
        const styleEl = container.querySelector('#video-style');
        if (styleEl) styleEl.onchange = e => { conceptStyle = e.target.value; };
        const charsEl = container.querySelector('#video-characters');
        if (charsEl) charsEl.oninput = e => { conceptCharacters = e.target.value; };
        const sbBtn = container.querySelector('#video-storyboard-btn');
        if (sbBtn) sbBtn.onclick = generateStoryboard;

        const charDescEl = container.querySelector('#video-char-desc');
        if (charDescEl) charDescEl.oninput = e => { characterPack.description = e.target.value; };
        const charFilesEl = container.querySelector('#video-char-files');
        if (charFilesEl) charFilesEl.onchange = async e => {
            const files = Array.from(e.target.files || []).slice(0, 3);
            characterPack.images = await Promise.all(files.map(readFileAsDataUrl));
            refresh();
        };

        // Storyboard / shot events
        container.querySelectorAll('[data-shot-prompt]').forEach(el => {
            el.oninput = e => {
                const s = shots.find(x => x.id === el.dataset.shotPrompt);
                if (s) s.prompt = e.target.value;
            };
        });
        container.querySelectorAll('[data-shot-dur]').forEach(el => {
            el.oninput = e => {
                const s = shots.find(x => x.id === el.dataset.shotDur);
                if (!s) return;
                s.durationSeconds = Number(e.target.value);
                const lbl = container.querySelector(`[data-shot-dur-label="${s.id}"]`);
                if (lbl) lbl.textContent = s.durationSeconds + 's';
            };
        });
        container.querySelectorAll('[data-shot-cam]').forEach(el => {
            el.onchange = e => {
                const s = shots.find(x => x.id === el.dataset.shotCam);
                if (s) s.cameraAngle = e.target.value;
            };
        });
        container.querySelectorAll('[data-shot-audio]').forEach(el => {
            el.onchange = e => {
                const s = shots.find(x => x.id === el.dataset.shotAudio);
                if (s) { s.audioMode = e.target.value; refresh(); }
            };
        });
        container.querySelectorAll('[data-shot-ref]').forEach(el => {
            el.onchange = async e => {
                const s = shots.find(x => x.id === el.dataset.shotRef);
                const f = e.target.files && e.target.files[0];
                if (s && f) { s.referenceImageUrl = await readFileAsDataUrl(f); refresh(); }
            };
        });
        container.querySelectorAll('.vg-model-pick').forEach(btn => {
            btn.onclick = () => {
                const s = shots.find(x => x.id === btn.dataset.shot);
                if (s) { s.model = btn.dataset.model; refresh(); }
            };
        });
        container.querySelectorAll('[data-shot-gen]').forEach(btn => {
            btn.onclick = () => generateShot(btn.dataset.shotGen);
        });
        container.querySelectorAll('[data-shot-up]').forEach(btn => {
            btn.onclick = () => moveShot(btn.dataset.shotUp, -1);
        });
        container.querySelectorAll('[data-shot-down]').forEach(btn => {
            btn.onclick = () => moveShot(btn.dataset.shotDown, 1);
        });
        container.querySelectorAll('[data-shot-del]').forEach(btn => {
            btn.onclick = () => {
                shots = shots.filter(s => s.id !== btn.dataset.shotDel);
                refresh();
            };
        });
        const genAll = container.querySelector('#video-generate-all');
        if (genAll) genAll.onclick = generateAllShots;
        const asmBtn = container.querySelector('#video-assemble');
        if (asmBtn) asmBtn.onclick = assembleFinalVideo;
        const tribeBtn = container.querySelector('#video-send-tribe');
        if (tribeBtn) tribeBtn.onclick = () => sendToTribe(assembledVideoUrl);
        const hookBtn = container.querySelector('#video-score-hook');
        if (hookBtn) hookBtn.onclick = () => scoreWithHookModel(shots[0]);

        // Parameters
        const param = (id, fn) => { const el = container.querySelector(id); if (el) fn(el); };
        param('#vp-quality', el => { el.onchange = e => { globalParams.quality = e.target.value; }; });
        param('#vp-seed', el => { el.oninput = e => { globalParams.seed = e.target.value; }; });
        param('#vp-guidance', el => {
            el.oninput = e => {
                globalParams.guidanceScale = Number(e.target.value);
                const lbl = container.querySelector('#vp-guidance-label');
                if (lbl) lbl.textContent = globalParams.guidanceScale;
            };
        });
        param('#vp-motion', el => { el.onchange = e => { globalParams.motionIntensity = e.target.value; }; });
        param('#vp-char', el => {
            el.oninput = e => {
                globalParams.characterStrength = Number(e.target.value);
                const lbl = container.querySelector('#vp-char-label');
                if (lbl) lbl.textContent = globalParams.characterStrength.toFixed(2);
            };
        });
        param('#vp-negative', el => { el.oninput = e => { globalParams.negativePrompt = e.target.value; }; });
        param('#vp-format', el => { el.onchange = e => { globalParams.outputFormat = e.target.value; }; });
        param('#vp-resolution', el => { el.onchange = e => { globalParams.resolution = e.target.value; }; });
        param('#vp-fps', el => { el.onchange = e => { globalParams.fps = Number(e.target.value); }; });
        param('#vp-audio-prompt', el => { el.oninput = e => { globalParams.audioPrompt = e.target.value; }; });
        param('#vp-safety', el => { el.onchange = e => { globalParams.safetyFilter = e.target.checked; }; });
        param('#vp-camera-move', el => { el.onchange = e => { globalParams.cameraMovement = e.target.value; }; });
        param('#vp-ref-video', el => { el.oninput = e => { globalParams.referenceVideoUrl = e.target.value; }; });
    }

    function moveShot(id, delta) {
        const i = shots.findIndex(s => s.id === id);
        if (i < 0) return;
        const j = i + delta;
        if (j < 0 || j >= shots.length) return;
        [shots[i], shots[j]] = [shots[j], shots[i]];
        refresh();
    }

    function readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = reject;
            r.readAsDataURL(file);
        });
    }

    function attach(el) { container = el; }
    function detach() {
        Object.values(pollTimers).forEach(t => clearInterval(t));
        pollTimers = {};
        container = null;
    }

    return { attach, detach, render };
})();
