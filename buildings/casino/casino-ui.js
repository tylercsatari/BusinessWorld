'use strict';

const CasinoUI = (() => {
    const GTOBASE_VIEWER_URL = 'https://app.gtobase.com/viewer?id=109&q=20#onePlayer-strategy';
    const ROLE_KEY = 'casinoCoachRole';
    const SPEAKER_KEY = 'casinoSpeakerOn';
    const LAST_SPOKEN_KEY = 'casinoLastSpokenOperatorAt';
    const POLL_MS = 1200;
    let container = null;
    let screen = 'entry';
    let roleMode = 'tyler';
    let speakerOn = true;
    let heroHand = '';
    let mediaRecorder = null;
    let mediaStream = null;
    let audioChunks = [];
    let recordingStarted = 0;
    let recordingTimer = null;
    let pollTimer = null;
    let ttsAudio = null;
    let speechChain = Promise.resolve();
    let busy = false;
    let seenMessageIds = new Set();
    let lastSpokenOperatorAt = '';

    function render() {
        return `<section class="casino-panel" aria-label="Casino poker coach">
            ${screen === 'entry' ? renderEntry() : screen === 'incoming' ? renderIncoming() : renderCall()}
        </section>`;
    }

    function renderHeader(subtitle) {
        return `<header class="casino-toolbar">
            <span class="casino-chip" aria-hidden="true">♠</span>
            <div class="casino-heading"><h2>Casino</h2><p>${subtitle}</p></div>
            <span class="casino-mode-badge">Human verified</span>
        </header>
        <nav class="casino-role-switch" aria-label="Poker coach role">
            <button type="button" data-casino-role="tyler" class="${roleMode === 'tyler' ? 'active' : ''}">Tyler</button>
            <button type="button" data-casino-role="operator" class="${roleMode === 'operator' ? 'active' : ''}">AI Robot</button>
        </nav>`;
    }

    function renderEntry() {
        return `${renderHeader('Human solver call')}
            <main class="casino-entry">
                <div class="casino-table" aria-hidden="true"><span class="casino-card casino-card-one">A♠</span><span class="casino-card casino-card-two">K♠</span><span class="casino-table-chip">LIVE</span></div>
                <div class="casino-copy"><span class="casino-eyebrow">Start a hand</span><h3>What are your cards?</h3><p>Enter your hand, answer the call, and speak the action. A logged-in human solver operator will reply.</p></div>
                <form id="casino-hand-form" class="casino-hand-form">
                    <label for="casino-hand-input">Hole cards</label>
                    <input id="casino-hand-input" type="text" autocomplete="off" autocapitalize="characters" maxlength="40" placeholder="Example: A♠ K♠ or ace king suited" required>
                    <p id="casino-entry-error" class="casino-form-error" role="alert"></p>
                    <button class="casino-primary" type="submit"><span>Call poker coach</span><span>☎</span></button>
                </form>
                <p class="casino-disclaimer">Only messages written by Tyler or the human solver operator appear in this call. No AI strategy figures are generated.</p>
            </main>`;
    }

    function renderIncoming() {
        return `${renderHeader('Incoming solver call')}
            <main class="casino-incoming">
                <div class="casino-call-avatar" aria-hidden="true">♠</div><span class="casino-call-label">Incoming call</span><h2>Poker Coach</h2>
                <p>${escapeHtml(heroHand)}</p>
                <div class="casino-call-actions">
                    <button id="casino-decline" class="casino-call-button decline" type="button"><span>×</span><small>Decline</small></button>
                    <button id="casino-answer" class="casino-call-button answer" type="button"><span>☎</span><small>Answer</small></button>
                </div>
            </main>`;
    }

    function renderCall() {
        const operator = roleMode === 'operator';
        return `${renderHeader(operator ? 'Solver desk · connected' : 'Poker Coach · connected')}
            <main class="casino-call ${operator ? 'operator-mode' : 'tyler-mode'}">
                <div class="casino-call-topline">
                    <div><strong>${operator ? 'Solver desk' : escapeHtml(heroHand || 'Live hand')}</strong><span>${operator ? 'Human response mode' : 'Live hand'}</span></div>
                    ${operator ? `<a class="casino-solver-link" href="${GTOBASE_VIEWER_URL}" target="_blank" rel="noopener noreferrer">Open GTOBase ↗</a>` : `<button id="casino-speaker-toggle" class="casino-audio-toggle ${speakerOn ? '' : 'quiet'}" type="button">${speakerOn ? '🔊 Speaker' : '🔈 Quiet'}</button>`}
                </div>
                <div id="casino-decision" class="casino-decision" aria-live="polite">
                    <span class="casino-decision-label">${operator ? 'AI Robot mode' : 'Human solver connected'}</span>
                    <strong>${operator ? 'Waiting for Tyler.' : 'Tell me what happened.'}</strong>
                    <p>${operator ? 'Calculate the exact move in GTOBase, then type the reply below.' : 'Your message is sent to the human solver desk. Their reply will be read aloud.'}</p>
                </div>
                <div id="casino-transcript" class="casino-transcript" aria-live="polite"></div>
                <div id="casino-recording-status" class="casino-recording-status">${operator ? 'Live inbox connected.' : 'Tap the microphone or type the action.'}</div>
                ${operator ? '' : `<div class="casino-call-controls"><button id="casino-mic" class="casino-mic" type="button" aria-label="Start recording"><span>🎙</span><small>Tap to talk</small></button><button id="casino-end-call" class="casino-end-call" type="button" aria-label="End call">×</button></div>`}
                <form id="casino-action-form" class="casino-action-form">
                    <input id="casino-action-input" type="text" autocomplete="off" placeholder="${operator ? 'Type exact solver move for Tyler…' : 'Type the poker action instead…'}">
                    <button type="submit" aria-label="Send message">↑</button>
                </form>
            </main>`;
    }

    function bind() {
        bindRoleSwitch();
        if (screen === 'entry') bindEntry();
        else if (screen === 'incoming') bindIncoming();
        else bindCall();
    }

    function bindRoleSwitch() {
        container.querySelectorAll('[data-casino-role]').forEach(button => button.addEventListener('click', () => switchRole(button.dataset.casinoRole)));
    }

    function switchRole(nextRole) {
        roleMode = nextRole === 'operator' ? 'operator' : 'tyler';
        try { localStorage.setItem(ROLE_KEY, roleMode); } catch (error) {}
        releaseAudio();
        stopPolling();
        seenMessageIds.clear();
        if (roleMode === 'operator') screen = 'call';
        else screen = 'entry';
        refresh();
    }

    function bindEntry() {
        const form = document.getElementById('casino-hand-form');
        form.addEventListener('submit', event => {
            event.preventDefault();
            const hand = document.getElementById('casino-hand-input').value.trim();
            if (hand.length < 2) {
                document.getElementById('casino-entry-error').textContent = 'Enter your hole cards.';
                return;
            }
            heroHand = hand; screen = 'incoming'; refresh();
        });
    }

    function bindIncoming() {
        document.getElementById('casino-decline').addEventListener('click', reset);
        document.getElementById('casino-answer').addEventListener('click', async () => {
            unlockAudio();
            lastSpokenOperatorAt = new Date().toISOString();
            persistLastSpoken();
            screen = 'call';
            seenMessageIds.clear();
            refresh();
            await sendSharedMessage(`New hand: ${heroHand}.`, 'hand');
            queueSpeak('What is the action?');
            updateStatus('What is the action? Tap the microphone after the prompt to answer.');
        });
    }

    function bindCall() {
        startPolling();
        const mic = document.getElementById('casino-mic');
        if (mic) mic.addEventListener('click', () => mediaRecorder && mediaRecorder.state === 'recording' ? stopRecording() : startRecording());
        const end = document.getElementById('casino-end-call');
        if (end) end.addEventListener('click', reset);
        const audioToggle = document.getElementById('casino-speaker-toggle');
        if (audioToggle) audioToggle.addEventListener('click', toggleSpeakerMode);
        document.getElementById('casino-action-form').addEventListener('submit', event => {
            event.preventDefault();
            const input = document.getElementById('casino-action-input');
            const text = input.value.trim();
            if (!text || busy) return;
            input.value = '';
            sendSharedMessage(text, 'message');
        });
    }

    function refresh() {
        if (!container) return;
        container.innerHTML = render();
        bind();
    }

    function startPolling() {
        stopPolling();
        pollMessages();
        pollTimer = setInterval(pollMessages, POLL_MS);
    }

    function stopPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
    }

    async function pollMessages() {
        if (!container || screen !== 'call') return;
        try {
            const response = await fetch('/api/casino/messages?limit=100');
            if (!response.ok) throw new Error(`Inbox unavailable (${response.status})`);
            const data = await response.json();
            const messages = Array.isArray(data.messages) ? data.messages : [];
            let newestReply = null;
            for (const message of messages) {
                if (!message.id || seenMessageIds.has(message.id)) continue;
                seenMessageIds.add(message.id);
                addMessage(message.content, message.sender === 'operator' ? 'assistant' : 'user', message.sender === 'operator' ? 'AI Robot' : 'Tyler');
                if (roleMode === 'tyler' && message.sender === 'operator' && message.timestamp > lastSpokenOperatorAt) newestReply = message;
            }
            if (newestReply) {
                lastSpokenOperatorAt = newestReply.timestamp;
                persistLastSpoken();
                showHumanReply(newestReply.content);
                queueSpeak(newestReply.content);
                updateStatus('Human solver replied. Tap the microphone to continue.');
            }
        } catch (error) {
            updateStatus(error.message);
        }
    }

    async function sendSharedMessage(text, kind) {
        if (busy) return;
        busy = true;
        updateStatus(roleMode === 'operator' ? 'Sending exact reply…' : 'Sending to human solver…', true);
        try {
            const response = await fetch('/api/casino/messages', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sender: roleMode, content: text, kind })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || `Send failed (${response.status})`);
            if (data.message && !seenMessageIds.has(data.message.id)) {
                seenMessageIds.add(data.message.id);
                addMessage(data.message.content, roleMode === 'operator' ? 'assistant' : 'user', roleMode === 'operator' ? 'AI Robot' : 'Tyler');
            }
            updateStatus(roleMode === 'operator' ? 'Reply delivered to Tyler.' : 'Delivered. Waiting for the human solver.');
        } catch (error) {
            addMessage(error.message, 'error', 'System');
            updateStatus('Message was not delivered. Try again.');
        } finally { busy = false; }
    }

    function addMessage(text, role, label) {
        const transcript = document.getElementById('casino-transcript');
        if (!transcript) return;
        const bubble = document.createElement('div');
        bubble.className = `casino-message ${role}`;
        const who = document.createElement('small'); who.textContent = label;
        const content = document.createElement('span'); content.textContent = text;
        bubble.append(who, content); transcript.appendChild(bubble); transcript.scrollTop = transcript.scrollHeight;
    }

    function showHumanReply(text) {
        const card = document.getElementById('casino-decision');
        if (!card) return;
        card.classList.add('has-action');
        card.replaceChildren();
        const label = document.createElement('span'); label.className = 'casino-decision-label'; label.textContent = 'Human solver reply';
        const action = document.createElement('strong'); action.textContent = text;
        const detail = document.createElement('p'); detail.textContent = 'Written by the AI Robot operator, not generated by the model.';
        card.append(label, action, detail);
    }

    function updateStatus(text, active) {
        const status = document.getElementById('casino-recording-status');
        if (status) { status.textContent = text; status.classList.toggle('active', Boolean(active)); }
    }

    async function startRecording() {
        if (roleMode !== 'tyler' || busy || !navigator.mediaDevices || !window.MediaRecorder) {
            if (!navigator.mediaDevices || !window.MediaRecorder) updateStatus('Voice is unavailable here. Type the action below.');
            return;
        }
        releaseStream();
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
            mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
            audioChunks = [];
            mediaRecorder.ondataavailable = event => { if (event.data.size) audioChunks.push(event.data); };
            mediaRecorder.onstop = transcribeRecording;
            mediaRecorder.start(250);
            recordingStarted = Date.now(); setMicVisual(true); updateRecordingClock();
            recordingTimer = setInterval(updateRecordingClock, 1000);
        } catch (error) {
            console.warn('Casino microphone error:', error && error.name, error && error.message);
            const blocked = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
            updateStatus(blocked
                ? 'Microphone is blocked for Business World. Open this site’s browser settings, set Microphone to Allow, then tap the mic again.'
                : 'The microphone could not start. Close other apps using it, then tap the mic again.');
            releaseStream();
        }
    }

    function updateRecordingClock() { updateStatus(`Listening… ${Math.floor((Date.now() - recordingStarted) / 1000)}s · tap to send`, true); }

    function stopRecording() {
        clearInterval(recordingTimer); recordingTimer = null;
        if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
        setMicVisual(false); updateStatus('Transcribing…', true);
    }

    async function transcribeRecording() {
        const recorderType = mediaRecorder && mediaRecorder.mimeType || 'audio/webm';
        const chunks = audioChunks.slice(); audioChunks = []; releaseStream();
        if (!chunks.length) { updateStatus('No audio captured. Tap to try again.'); return; }
        try {
            const audio = await blobToBase64(new Blob(chunks, { type: recorderType }));
            const response = await fetch('/api/openai/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio, mimeType: recorderType }) });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Transcription failed');
            const text = String(result.text || '').trim();
            if (!text) { updateStatus('I did not hear anything. Tap to try again.'); return; }
            await sendSharedMessage(text, 'message');
        } catch (error) { addMessage(`Voice error: ${error.message}`, 'error', 'System'); updateStatus('Type the action below or tap to try again.'); }
    }

    function setMicVisual(recording) {
        const button = document.getElementById('casino-mic');
        if (!button) return;
        button.classList.toggle('recording', recording);
        button.querySelector('small').textContent = recording ? 'Tap to send' : 'Tap to talk';
    }

    function unlockAudio() {
        if (!ttsAudio) ttsAudio = new Audio();
        const previousSource = ttsAudio.src;
        ttsAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGFpYQAAAAA=';
        ttsAudio.play().then(() => {
            ttsAudio.pause();
            ttsAudio.src = previousSource || '';
        }).catch(() => { ttsAudio.src = previousSource || ''; });
        applyAudioMode(false);
    }

    async function toggleSpeakerMode() {
        speakerOn = !speakerOn;
        try { localStorage.setItem(SPEAKER_KEY, speakerOn ? 'yes' : 'no'); } catch (error) {}
        await applyAudioMode(true);
        const button = document.getElementById('casino-speaker-toggle');
        if (button) { button.textContent = speakerOn ? '🔊 Speaker' : '🔈 Quiet'; button.classList.toggle('quiet', !speakerOn); }
        updateStatus(speakerOn ? 'Speaker mode is on.' : 'Quiet mode is on. Choose an earpiece or headphones if your browser offers an output picker.');
    }

    async function applyAudioMode(userGesture) {
        if (!ttsAudio) ttsAudio = new Audio();
        ttsAudio.volume = speakerOn ? 1 : 0.2;
        try { if (navigator.audioSession) navigator.audioSession.type = speakerOn ? 'playback' : 'play-and-record'; } catch (error) {}
        if (!speakerOn && userGesture && navigator.mediaDevices && navigator.mediaDevices.selectAudioOutput && ttsAudio.setSinkId) {
            try { const device = await navigator.mediaDevices.selectAudioOutput(); if (device && device.deviceId) await ttsAudio.setSinkId(device.deviceId); } catch (error) {}
        } else if (speakerOn && ttsAudio.setSinkId) {
            try { await ttsAudio.setSinkId('default'); } catch (error) {}
        }
    }

    function queueSpeak(text) { speechChain = speechChain.then(() => speak(text)).catch(() => {}); }

    async function speak(text) {
        if (roleMode !== 'tyler') return;
        await applyAudioMode(false);
        try {
            const response = await fetch('/api/openai/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: text, voice: 'alloy' }) });
            if (!response.ok) throw new Error('TTS unavailable');
            const blob = await response.blob(); const url = URL.createObjectURL(blob);
            ttsAudio.pause(); ttsAudio.src = url; ttsAudio.volume = speakerOn ? 1 : 0.2;
            await new Promise((resolve, reject) => {
                ttsAudio.onended = () => { URL.revokeObjectURL(url); ttsAudio.src = ''; resolve(); };
                ttsAudio.onerror = reject; ttsAudio.play().catch(reject);
            });
        } catch (error) {
            if ('speechSynthesis' in window) {
                const utterance = new SpeechSynthesisUtterance(text); utterance.volume = speakerOn ? 1 : 0.2;
                await new Promise(resolve => { utterance.onend = resolve; utterance.onerror = resolve; window.speechSynthesis.speak(utterance); });
            }
        }
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onloadend = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
    }

    function releaseStream() { if (mediaStream) mediaStream.getTracks().forEach(track => track.stop()); mediaStream = null; mediaRecorder = null; }

    function reset() { releaseAudio(); stopPolling(); screen = 'entry'; seenMessageIds.clear(); refresh(); }

    function releaseAudio() {
        clearInterval(recordingTimer); recordingTimer = null;
        if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.onstop = null; try { mediaRecorder.stop(); } catch (error) {} }
        releaseStream();
        if (ttsAudio) { ttsAudio.pause(); ttsAudio.src = ''; }
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }

    function persistLastSpoken() { try { localStorage.setItem(LAST_SPOKEN_KEY, lastSpokenOperatorAt); } catch (error) {} }
    function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }

    return {
        open(bodyEl) {
            container = bodyEl;
            try { roleMode = localStorage.getItem(ROLE_KEY) === 'operator' ? 'operator' : 'tyler'; } catch (error) { roleMode = 'tyler'; }
            try { speakerOn = localStorage.getItem(SPEAKER_KEY) !== 'no'; } catch (error) { speakerOn = true; }
            try { lastSpokenOperatorAt = localStorage.getItem(LAST_SPOKEN_KEY) || ''; } catch (error) { lastSpokenOperatorAt = ''; }
            screen = roleMode === 'operator' ? 'call' : 'entry';
            refresh();
        },
        close() { releaseAudio(); stopPolling(); if (container) container.innerHTML = ''; container = null; }
    };
})();

window.CasinoUI = CasinoUI;

BuildingRegistry.register('Casino', { open: bodyEl => CasinoUI.open(bodyEl), close: () => CasinoUI.close() });
