/**
 * Storage UI — panel rendering, voice I/O, chat, suggestion handling.
 * Ported from StorageAI/src/ui/main_window.py and sorting_logic.py
 */
const StorageUI = (() => {
    let container = null;
    let chatLog = null;
    let initialized = false;
    let micState = 'idle'; // idle | recording | processing
    let persistentStream = null; // getUserMedia stream — kept alive across recordings
    let audioSessionCtx = null; // AudioContext anchoring iOS audio session in record mode
    let mediaRecorder = null; // MediaRecorder instance
    let audioChunks = []; // recorded audio chunks
    let recordingTimer = null; // interval for elapsed-time display
    let recordingStart = 0; // Date.now() when recording began
    let ttsAudio = null; // current TTS audio element
    let audioUnlocked = false; // whether mobile audio has been unlocked
    let ttsNeedsRelease = false; // whether TTS audio element has content needing release
    let history = []; // activity history log
    let historyVisible = false;

    async function loadHistory() {
        // Airtable is the sole source of truth — no localStorage
        try {
            const records = await StorageAirtable.listHistory();
            history = records.sort((a, b) => a.time.localeCompare(b.time));
        } catch (e) {
            console.warn('History: Airtable load failed', e);
            history = [];
        }
    }

    async function addHistory(action, details) {
        const time = new Date().toISOString();
        const entry = { time, action, details };
        // Add to in-memory list for immediate display
        history.push(entry);
        if (historyVisible) renderHistory();
        // Write to Airtable — await so we know if it fails
        try {
            await StorageAirtable.addHistoryRecord(action, details, time);
        } catch (e) {
            console.warn('History: Airtable write failed', e);
        }
    }

    function renderHistory() {
        const list = document.getElementById('storage-history-list');
        if (!list) return;
        if (history.length === 0) {
            list.innerHTML = '<div style="padding:10px;color:#999;font-style:italic;">No activity yet.</div>';
            return;
        }
        // Show newest first
        list.innerHTML = history.slice().reverse().map(h => {
            const d = new Date(h.time);
            const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
            return `<div class="storage-history-entry">
                <span class="storage-history-action">${escHtml(h.action)}</span>
                <span class="storage-history-details">${escHtml(h.details)}</span>
                <span class="storage-history-time">${date} ${time}</span>
            </div>`;
        }).join('');
    }

    // --- Rendering ---
    function render() {
        return `
        <div class="storage-panel">
            <div class="storage-header">
                <h2>Storage Room</h2>
                <div class="storage-stats">
                    <span class="storage-stat" id="storage-box-count">0 boxes</span>
                    <span class="storage-stat" id="storage-item-count">0 items</span>
                </div>
            </div>
            <div class="storage-body">
                <div class="storage-left">
                    <div class="storage-toolbar">
                        <button onclick="StorageUI.onAddItem()">+ Add Item</button>
                        <button onclick="StorageUI.onRemoveItem()">- Remove Item</button>
                        <button onclick="StorageUI.onSearch()">Search</button>
                        <button onclick="StorageUI.onAddBox()">+ Add Box</button>
                        <button onclick="StorageUI.onRemoveBox()">- Remove Box</button>
                        <button class="sync-btn" onclick="StorageUI.onSync()">Sync</button>
                        <button class="sync-btn" onclick="StorageUI.onToggleHistory()">History</button>
                    </div>
                    <div class="storage-boxes-grid" id="storage-boxes-grid">
                        <div class="storage-loading"><div class="storage-spinner"></div></div>
                    </div>
                    <div class="storage-history" id="storage-history" style="display:none;">
                        <h3>Activity History</h3>
                        <div class="storage-history-list" id="storage-history-list"></div>
                    </div>
                </div>
                <div class="storage-chat">
                    <div class="storage-chat-header">
                        <span>Chat</span>
                        <button class="storage-mic-btn" id="storage-mic-btn" onclick="StorageUI.onMicToggle()" title="Voice input">
                            <svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" fill="currentColor"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" fill="currentColor"/></svg>
                        </button>
                    </div>
                    <div class="storage-chat-log" id="storage-chat-log">
                        <div class="storage-chat-msg system">Welcome! Type or speak commands like "add 3 batteries to box A" or ask "where are the scissors?"</div>
                    </div>
                    <div class="storage-voice-preview" id="storage-voice-preview" style="display:none;">Listening...</div>
                    <div class="storage-chat-input-row">
                        <input type="text" id="storage-chat-input" placeholder="Type a command or question..." onkeydown="if(event.key==='Enter')StorageUI.onChatSend()">
                        <button onclick="StorageUI.onChatSend()">Send</button>
                    </div>
                </div>
            </div>
        </div>`;
    }

    function updateStats() {
        const boxes = StorageService.getBoxes();
        const items = StorageService.getItems();
        const bc = document.getElementById('storage-box-count');
        const ic = document.getElementById('storage-item-count');
        if (bc) bc.textContent = `${boxes.length} box${boxes.length !== 1 ? 'es' : ''}`;
        if (ic) ic.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;
    }

    function renderBoxes() {
        const grid = document.getElementById('storage-boxes-grid');
        if (!grid) return;
        const boxes = StorageService.getBoxes();
        if (boxes.length === 0) {
            grid.innerHTML = '<div style="padding:20px;text-align:center;color:#bbb;font-style:italic;">No boxes yet. Add one to get started!</div>';
            return;
        }
        grid.innerHTML = boxes.map(box => {
            const items = StorageService.getItemsByBox(box.id);
            const itemRows = items.length > 0
                ? `<table>${items.map(i => `<tr><td>${escHtml(i.name)}</td><td>${i.quantity}</td></tr>`).join('')}</table>`
                : '<div class="storage-box-empty">Empty</div>';
            return `<div class="storage-box-card">
                <h3>${escHtml(box.name)}</h3>
                <div class="storage-box-items">${itemRows}</div>
            </div>`;
        }).join('');
    }

    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function addChatMsg(text, type = 'system') {
        chatLog = document.getElementById('storage-chat-log');
        if (!chatLog) return;
        const div = document.createElement('div');
        div.className = `storage-chat-msg ${type}`;
        div.textContent = text;
        chatLog.appendChild(div);
        chatLog.scrollTop = chatLog.scrollHeight;
    }

    function showSuggestions(suggestions) {
        if (!suggestions || suggestions.length === 0) return;
        const sugText = suggestions.map((s, i) =>
            `${i + 1}. ${s.name} (score: ${(s.score * 100).toFixed(0)}%${s.boxName ? ', in ' + s.boxName : ''})`
        ).join('\n');
        addChatMsg(`Did you mean:\n${sugText}`, 'system');
    }

    // --- Voice I/O (MediaRecorder + Whisper) ---
    function setMicState(state) {
        micState = state;
        const btn = document.getElementById('storage-mic-btn');
        if (!btn) return;
        btn.classList.remove('recording', 'processing');
        if (state === 'recording') btn.classList.add('recording');
        if (state === 'processing') btn.classList.add('processing');
    }

    function showVoicePreview(text) {
        const preview = document.getElementById('storage-voice-preview');
        if (preview) { preview.textContent = text; preview.style.display = 'block'; }
    }

    function hideVoicePreview() {
        const preview = document.getElementById('storage-voice-preview');
        if (preview) preview.style.display = 'none';
    }

    function updateRecordingTimer() {
        const secs = Math.floor((Date.now() - recordingStart) / 1000);
        showVoicePreview(`Recording... ${secs}s`);
    }

    // Acquire the mic stream once and keep it alive for the entire session.
    // On mobile, after TTS playback a fresh getUserMedia call can return a
    // stream that looks active but silently captures no audio.  Keeping one
    // stream alive (plus an AudioContext anchor) prevents the OS from
    // switching the audio session out of recording mode when TTS plays.
    async function ensureMicStream() {
        if (persistentStream && persistentStream.active) {
            const track = persistentStream.getAudioTracks()[0];
            if (track && track.readyState === 'live') return persistentStream;
        }
        persistentStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Anchor the audio session in "play-and-record" mode on iOS by
        // connecting the mic stream to a live AudioContext.  Without this,
        // playing TTS switches the session to playback-only, muting the mic.
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC) {
                if (audioSessionCtx) try { audioSessionCtx.close(); } catch (e) {}
                audioSessionCtx = new AC();
                audioSessionCtx.createMediaStreamSource(persistentStream);
                // Don't connect to destination — just keeping the source alive
                // is enough to hold the audio session in recording mode.
            }
        } catch (e) { /* AudioContext not available — recording still works */ }
        return persistentStream;
    }

    function releaseAllAudio() {
        if (audioSessionCtx) { try { audioSessionCtx.close(); } catch (e) {} audioSessionCtx = null; }
        if (persistentStream) { persistentStream.getTracks().forEach(t => t.stop()); persistentStream = null; }
    }

    async function startRecording() {
        // Stop old MediaRecorder if still active, then null it out to
        // prevent its async onstop from interfering with the new recording.
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.onstop = null;
            try { mediaRecorder.stop(); } catch (e) {}
        }
        mediaRecorder = null;

        // Track if this is a subsequent recording (stream was previously active)
        const isSubsequent = !!persistentStream;

        // Force a fresh mic stream every time — on mobile, reused streams
        // silently stop capturing audio after TTS playback even though the
        // track still reports readyState === 'live'.
        if (persistentStream) {
            persistentStream.getTracks().forEach(t => t.stop());
            persistentStream = null;
        }
        if (audioSessionCtx) {
            try { audioSessionCtx.close(); } catch (e) {}
            audioSessionCtx = null;
        }

        // On subsequent recordings, let the OS fully release the previous
        // audio stream before requesting a new one — some mobile browsers
        // return a frozen track if getUserMedia is called too quickly.
        if (isSubsequent) {
            await new Promise(r => setTimeout(r, 150));
        }

        let stream;
        try {
            stream = await ensureMicStream();
        } catch (e) {
            addChatMsg('Microphone access denied. Check browser permissions.', 'error');
            setMicState('idle');
            return;
        }

        // Resume AudioContext if iOS suspended it (e.g. after backgrounding)
        if (audioSessionCtx && audioSessionCtx.state === 'suspended') {
            try { await audioSessionCtx.resume(); } catch (e) {}
        }

        audioChunks = [];
        // Pick a supported MIME type — iOS Safari uses mp4, Chrome uses webm
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
                       : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
                       : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
                       : '';
        mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType })
                                 : new MediaRecorder(stream);

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunks.push(e.data);
        };

        // Capture mimeType in closure so async onstop uses the correct recorder's type
        const recorderMimeType = mediaRecorder.mimeType;
        mediaRecorder.onstop = async () => {
            // Stream stays alive — don't stop it.  Only the MediaRecorder ends.
            if (audioChunks.length === 0) { setMicState('idle'); hideVoicePreview(); return; }
            const blob = new Blob(audioChunks, { type: recorderMimeType });
            audioChunks = [];
            await transcribeAndProcess(blob);
        };

        mediaRecorder.onerror = (e) => {
            console.error('MediaRecorder error:', e);
            setMicState('idle');
            addChatMsg('Recording error. Try again.', 'error');
        };

        // Use timeslice to fire ondataavailable every 250ms — guarantees
        // chunks accumulate on mobile browsers that don't fire it on stop.
        mediaRecorder.start(250);
        recordingStart = Date.now();
        updateRecordingTimer();
        recordingTimer = setInterval(updateRecordingTimer, 1000);
    }

    function stopRecording() {
        clearInterval(recordingTimer);
        recordingTimer = null;
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop(); // triggers onstop → transcribeAndProcess
        } else {
            setMicState('idle');
            hideVoicePreview();
        }
    }

    async function transcribeAndProcess(blob) {
        showVoicePreview('Transcribing...');
        setMicState('processing');
        try {
            // Encode audio as base64 and send to server for Whisper transcription
            const base64 = await blobToBase64(blob);
            const res = await fetch('/api/openai/transcribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audio: base64, mimeType: blob.type })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: 'Transcription failed' }));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            const data = await res.json();
            const text = (data.text || '').trim();
            hideVoicePreview();
            if (!text) {
                addChatMsg('No speech detected. Try again.', 'system');
                setMicState('idle');
                return;
            }
            addChatMsg(text, 'user');
            await processUserInput(text);
        } catch (e) {
            hideVoicePreview();
            addChatMsg(`Voice error: ${e.message}`, 'error');
        } finally {
            if (micState === 'processing') setMicState('idle');
            mediaRecorder = null; // clean state for next recording
        }
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const dataUrl = reader.result;
                resolve(dataUrl.split(',')[1]); // strip "data:...;base64,"
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    // Release TTS audio session so microphone can capture on iOS.
    // iOS Safari holds an audio session after Audio element playback, which
    // blocks SpeechRecognition mic input and causes headphone play button to
    // replay TTS. Clearing src + load() fully releases the session.
    function releaseTTSAudio() {
        if (ttsAudio) {
            ttsAudio.onended = null;
            ttsAudio.onerror = null;
            ttsAudio.pause();
            // Only run the expensive src-clear + load() when there is real
            // content to release.  A redundant load() on an already-empty
            // Audio element can briefly reclaim audio resources on mobile,
            // which silently blocks SpeechRecognition mic input.
            if (ttsNeedsRelease) {
                const oldSrc = ttsAudio.src;
                ttsAudio.src = '';
                ttsAudio.load();
                if (oldSrc && oldSrc.startsWith('blob:')) URL.revokeObjectURL(oldSrc);
                ttsNeedsRelease = false;
            }
        }
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }

    // Unlock audio playback on mobile — must be called from a user gesture (tap/click)
    function unlockAudio() {
        if (audioUnlocked) return;
        // Create a reusable Audio element and play a tiny silent clip to unlock playback
        ttsAudio = new Audio();
        // Tiny silent WAV (44 bytes header + 1 sample)
        ttsAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGFpYQAAAAA=';
        ttsAudio.play().then(() => {
            ttsAudio.pause();
            audioUnlocked = true;
        }).catch(() => {});
    }

    async function speakTTS(text) {
        // Try OpenAI TTS first for high-quality voice
        try {
            const res = await fetch('/api/openai/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: text })
            });
            if (res.ok) {
                const arrayBuffer = await res.arrayBuffer();

                // ---- Preferred path: play through AudioContext ----
                // When the mic stream is active, an AudioContext anchors the
                // iOS audio session in play-and-record mode.  Playing TTS
                // through that SAME context keeps the session there.  Using
                // an <audio> element instead would switch the session to
                // playback-only, silently killing the mic stream.
                if (audioSessionCtx && audioSessionCtx.state !== 'closed') {
                    try {
                        if (audioSessionCtx.state === 'suspended') await audioSessionCtx.resume();
                        // .slice(0) — decodeAudioData detaches the buffer
                        const decoded = await audioSessionCtx.decodeAudioData(arrayBuffer.slice(0));
                        const source = audioSessionCtx.createBufferSource();
                        source.buffer = decoded;
                        source.connect(audioSessionCtx.destination);
                        source.start(0);
                        return; // plays in background, no audio-session switch
                    } catch (e) {
                        console.warn('AudioContext TTS failed, falling back:', e.message);
                    }
                }

                // ---- Fallback: <audio> element (used when no mic session) ----
                const contentType = res.headers.get('content-type') || 'audio/mpeg';
                const blob = new Blob([arrayBuffer], { type: contentType });
                const url = URL.createObjectURL(blob);
                if (ttsAudio) {
                    ttsAudio.pause();
                    const oldSrc = ttsAudio.src;
                    ttsAudio.src = url;
                    ttsNeedsRelease = true;
                    ttsAudio.onended = () => { releaseTTSAudio(); };
                    ttsAudio.play().catch(e => {
                        console.warn('Audio play failed:', e.message);
                        fallbackBrowserTTS(text);
                    });
                    if (oldSrc && oldSrc.startsWith('blob:')) URL.revokeObjectURL(oldSrc);
                } else {
                    ttsAudio = new Audio(url);
                    ttsNeedsRelease = true;
                    ttsAudio.onended = () => { releaseTTSAudio(); };
                    ttsAudio.play().catch(e => {
                        console.warn('Audio play failed:', e.message);
                        fallbackBrowserTTS(text);
                    });
                }
                return;
            }
        } catch (e) {
            console.warn('OpenAI TTS failed, falling back to browser TTS:', e.message);
        }
        fallbackBrowserTTS(text);
    }

    function fallbackBrowserTTS(text) {
        if ('speechSynthesis' in window) {
            const utter = new SpeechSynthesisUtterance(text);
            utter.rate = 1.0;
            window.speechSynthesis.speak(utter);
        }
    }

    // --- Intent Handling (from sorting_logic.py) ---
    async function handleIntent(parsed) {
        try {
            switch (parsed.intent) {
                case 'ADD': {
                    if (!parsed.boxName) {
                        parsed.boxName = prompt('Which box? (e.g. A, B, C)');
                        if (!parsed.boxName) { addChatMsg('Cancelled.', 'system'); return; }
                        parsed.boxName = parsed.boxName.toUpperCase();
                    }
                    const r = await StorageService.addItem(parsed.itemName, parsed.quantity || 1, parsed.boxName);
                    const msg = r.merged
                        ? `Merged with existing "${r.mergedWith}" in box ${r.boxName} (${(r.score * 100).toFixed(0)}% match). Now ${r.item.quantity}x total.`
                        : `Added ${parsed.quantity || 1}x ${r.item.name} to box ${r.boxName}.`;
                    addChatMsg(msg, 'system');
                    addHistory('ADD', `${parsed.quantity || 1}x ${r.item.name} → Box ${r.boxName}`);
                    await speakTTS(msg);
                    break;
                }
                case 'REMOVE': {
                    const r = await StorageService.removeItem(parsed.itemName, parsed.quantity || 1);
                    if (r.error) {
                        addChatMsg(r.error, 'error');
                        if (r.suggestions && r.suggestions.length > 0) showSuggestions(r.suggestions);
                        return;
                    }
                    const fromBox = r.boxName ? ` from box ${r.boxName}` : '';
                    const msg = r.deleted
                        ? `Removed all ${r.item.name}${fromBox}.`
                        : `Removed ${parsed.quantity || 1}x ${r.item.name}${fromBox}. ${r.item.quantity} remaining.`;
                    addChatMsg(msg, 'system');
                    addHistory('REMOVE', r.deleted ? `All ${r.item.name}${fromBox}` : `${parsed.quantity || 1}x ${r.item.name}${fromBox} (${r.item.quantity} left)`);
                    await speakTTS(msg);
                    break;
                }
                case 'FIND': {
                    const r = await StorageService.findItem(parsed.itemName);
                    if (r.results.length === 0) {
                        addChatMsg(`No items matching "${parsed.itemName}" found.`, 'system');
                        if (r.suggestions.length > 0) showSuggestions(r.suggestions);
                        await speakTTS(`I couldn't find ${parsed.itemName}.`);
                        return;
                    }
                    const lines = r.results.map(m =>
                        `${m.name} (x${m.quantity}) in ${m.box} — ${(m.score * 100).toFixed(0)}% match`
                    );
                    const msg = `Found:\n${lines.join('\n')}`;
                    addChatMsg(msg, 'system');
                    await speakTTS(`Found ${r.results[0].name}, ${r.results[0].quantity} in box ${r.results[0].box}.`);
                    break;
                }
                case 'MOVE': {
                    if (!parsed.toBox) {
                        parsed.toBox = prompt('Move to which box?');
                        if (!parsed.toBox) { addChatMsg('Cancelled.', 'system'); return; }
                        parsed.toBox = parsed.toBox.toUpperCase();
                    }
                    const r = await StorageService.moveItem(parsed.itemName, parsed.toBox);
                    if (r.error) {
                        addChatMsg(r.error, 'error');
                        if (r.suggestions && r.suggestions.length > 0) showSuggestions(r.suggestions);
                        return;
                    }
                    const msg = `Moved ${r.item.name} to box ${r.toBox}.`;
                    addChatMsg(msg, 'system');
                    addHistory('MOVE', `${r.item.name} → Box ${r.toBox}`);
                    await speakTTS(msg);
                    break;
                }
                case 'ADD_BOX': {
                    let name = parsed.boxName;
                    if (!name) {
                        name = prompt('Box name?');
                        if (!name) { addChatMsg('Cancelled.', 'system'); return; }
                    }
                    const r = await StorageService.addBox(name);
                    if (r.error) { addChatMsg(r.error, 'error'); return; }
                    const msg = `Created box ${r.box.name}.`;
                    addChatMsg(msg, 'system');
                    addHistory('ADD BOX', r.box.name);
                    await speakTTS(msg);
                    break;
                }
                case 'REMOVE_BOX': {
                    const r = await StorageService.removeBox(parsed.boxName);
                    if (r.error) { addChatMsg(r.error, 'error'); return; }
                    const msg = `Removed box ${r.box.name}.`;
                    addChatMsg(msg, 'system');
                    addHistory('REMOVE BOX', r.box.name);
                    await speakTTS(msg);
                    break;
                }
                case 'CLEAR_BOX': {
                    const r = await StorageService.clearBox(parsed.boxName);
                    if (r.error) { addChatMsg(r.error, 'error'); return; }
                    const msg = `Cleared ${r.count} items from box ${r.box.name}.`;
                    addChatMsg(msg, 'system');
                    addHistory('CLEAR BOX', `${r.count} items from ${r.box.name}`);
                    await speakTTS(msg);
                    break;
                }
                default:
                    addChatMsg(`Unknown intent: ${parsed.intent}`, 'error');
                    return;
            }
            renderBoxes();
            updateStats();
        } catch (e) {
            addChatMsg(`Error: ${e.message}`, 'error');
        }
    }

    // --- AI Chat (OpenAI with inventory context) ---
    async function askAI(question) {
        const boxes = StorageService.getBoxes();
        const inventory = boxes.map(b => {
            const bItems = StorageService.getItemsByBox(b.id);
            const list = bItems.map(i => `  - ${i.name} (qty: ${i.quantity})`).join('\n');
            return `Box ${b.name}:\n${list || '  (empty)'}`;
        }).join('\n');

        try {
            const response = await StorageIntent.gptChat([
                {
                    role: 'system',
                    content: `You are a helpful storage inventory assistant. You have access to the user's physical storage inventory organized in labeled boxes. Here is the current inventory:\n\n${inventory}\n\nAnswer questions about the inventory concisely. If the user asks where something is, search through the inventory. If you can't find an exact match, suggest similar items.`
                },
                { role: 'user', content: question }
            ], 0.7);
            addChatMsg(response, 'ai');
            await speakTTS(response);
        } catch (e) {
            addChatMsg(`AI error: ${e.message}`, 'error');
        }
    }

    // --- Process user input (unified flow) ---
    async function processUserInput(text) {
        // Try multi-intent extraction for compound commands
        const intents = await StorageIntent.parseMulti(text);
        if (intents && intents.length > 0) {
            if (intents.length > 1) {
                addChatMsg(`Processing ${intents.length} operations...`, 'system');
            }
            for (const intent of intents) {
                await handleIntent(intent);
            }
        } else {
            // No structured intent found — ask AI
            await askAI(text);
        }
    }

    return {
        async open(bodyEl) {
            container = bodyEl;
            container.innerHTML = render();
            await loadHistory();

            try {
                await StorageService.sync();
                renderBoxes();
                updateStats();
            } catch (e) {
                const grid = document.getElementById('storage-boxes-grid');
                if (grid) grid.innerHTML = `<div class="storage-chat-msg error" style="margin:20px;">Failed to load inventory: ${escHtml(e.message)}</div>`;
            }
            initialized = true;
        },

        close() {
            clearInterval(recordingTimer);
            recordingTimer = null;
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                mediaRecorder.onstop = null; // prevent transcription on close
                try { mediaRecorder.stop(); } catch (e) {}
            }
            mediaRecorder = null;
            releaseAllAudio();
            audioChunks = [];
            if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }
            audioUnlocked = false;
            ttsNeedsRelease = false;
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            micState = 'idle';
            container = null;
            initialized = false;
            historyVisible = false;
        },

        onMicToggle() {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                addChatMsg('Voice input not supported in this browser.', 'error');
                return;
            }
            // Unlock audio on user gesture so TTS can play after async processing
            unlockAudio();
            if (micState === 'recording') {
                // Stop recording — onstop handler will transcribe and process
                stopRecording();
            } else if (micState !== 'processing') {
                // idle — start new recording
                // Release TTS audio session first — iOS holds it after playback,
                // blocking mic input and hijacking headphone controls
                releaseTTSAudio();
                setMicState('recording');
                startRecording();
            }
        },

        async onSync() {
            const grid = document.getElementById('storage-boxes-grid');
            if (grid) grid.innerHTML = '<div class="storage-loading"><div class="storage-spinner"></div></div>';
            try {
                await StorageService.sync();
                renderBoxes();
                updateStats();
                addChatMsg('Synced with Airtable.', 'system');
            } catch (e) {
                addChatMsg(`Sync error: ${e.message}`, 'error');
            }
        },

        onToggleHistory() {
            const grid = document.getElementById('storage-boxes-grid');
            const hist = document.getElementById('storage-history');
            if (!grid || !hist) return;
            historyVisible = !historyVisible;
            grid.style.display = historyVisible ? 'none' : '';
            hist.style.display = historyVisible ? 'block' : 'none';
            if (historyVisible) renderHistory();
        },

        onAddItem() {
            const name = prompt('Item name:');
            if (!name) return;
            const qtyStr = prompt('Quantity:', '1');
            const qty = parseInt(qtyStr) || 1;
            const box = prompt('Box name (e.g. A, B, C):');
            if (!box) return;
            addChatMsg(`Adding ${qty}x ${name} to box ${box.toUpperCase()}...`, 'user');
            handleIntent({ intent: 'ADD', itemName: name.trim(), quantity: qty, boxName: box.toUpperCase() });
        },

        onRemoveItem() {
            const name = prompt('Item name to remove:');
            if (!name) return;
            const qtyStr = prompt('Quantity to remove (or "all"):', '1');
            const qty = qtyStr.toLowerCase() === 'all' ? 9999 : (parseInt(qtyStr) || 1);
            addChatMsg(`Removing ${qtyStr}x ${name}...`, 'user');
            handleIntent({ intent: 'REMOVE', itemName: name.trim(), quantity: qty, removeAll: qty >= 9999 });
        },

        onSearch() {
            const name = prompt('Search for item:');
            if (!name) return;
            addChatMsg(`Searching for "${name}"...`, 'user');
            handleIntent({ intent: 'FIND', itemName: name.trim() });
        },

        onAddBox() {
            const name = prompt('New box name:');
            if (!name) return;
            handleIntent({ intent: 'ADD_BOX', boxName: name.toUpperCase() });
        },

        onRemoveBox() {
            const name = prompt('Box name to remove:');
            if (!name) return;
            addChatMsg(`Removing box ${name.toUpperCase()}...`, 'user');
            handleIntent({ intent: 'REMOVE_BOX', boxName: name.toUpperCase() });
        },

        async onChatSend() {
            const input = document.getElementById('storage-chat-input');
            if (!input) return;
            const text = input.value.trim();
            if (!text) return;
            input.value = '';
            unlockAudio();
            addChatMsg(text, 'user');
            await processUserInput(text);
        }
    };
})();

// Register with building registry
BuildingRegistry.register('Storage', {
    open: (bodyEl) => StorageUI.open(bodyEl),
    close: () => StorageUI.close()
});
