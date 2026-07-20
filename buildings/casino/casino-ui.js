'use strict';

const CasinoUI = (() => {
    const GTOBASE_VIEWER_URL = 'https://app.gtobase.com/viewer?id=109&q=20#onePlayer-strategy';
    const ROLE_KEY = 'casinoCoachRole';
    const SPEAKER_KEY = 'casinoSpeakerOn';
    const POLL_MS = 1200;
    let container = null;
    let screen = 'entry';
    let roleMode = 'tyler';
    let speakerOn = true;
    let heroHand = '';
    let mediaRecorder = null;
    let mediaStream = null;
    let audioContext = null;
    let audioAnalyser = null;
    let vadSamples = null;
    let vadFrame = null;
    let voiceStartedAt = 0;
    let lastVoiceAt = 0;
    let noiseFloor = 0.012;
    let alwaysListening = false;
    let isSpeakingReply = false;
    let transcriptionChain = Promise.resolve();
    let messageSendChain = Promise.resolve();
    let pollTimer = null;
    let ttsAudio = null;
    let playbackContext = null;
    let playbackSource = null;
    let speechChain = Promise.resolve();
    let queuedSpeechIds = new Set();
    let recentSpeechContent = new Map();
    let speechGeneration = 0;
    let aiReplyQueuedOrPlaying = false;
    let busy = false;
    let seenMessageIds = new Set();
    let tylerCallStartedAt = '';
    let ringContext = null;
    let ringTimer = null;
    let ringStops = [];

    function speakerIcon() {
        return speakerOn
            ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path class="sound-wave" d="M16 8.5c1.8 2 1.8 5 0 7M18.7 6c3.2 3.5 3.2 8.5 0 12"/></svg>'
            : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path class="sound-wave" d="m16.5 9 4 6m0-6-4 6"/></svg>';
    }

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
            <button type="button" data-casino-role="operator" class="${roleMode === 'operator' ? 'active' : ''}">AI</button>
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
                    <button id="casino-decline" class="casino-call-button decline" type="button"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 15.2c4.8-3.7 10.2-3.7 15 0l-2.2 3.3c-.3.5-.9.7-1.4.4l-2.2-1.2c-.3-.2-.5-.5-.5-.9v-1.1c-.8-.2-1.6-.2-2.4 0v1.1c0 .4-.2.7-.5.9l-2.2 1.2c-.5.3-1.1.1-1.4-.4l-2.2-3.3Z"/></svg></span><small>Decline</small></button>
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
                    ${operator ? `<a class="casino-solver-link" href="${GTOBASE_VIEWER_URL}" target="_blank" rel="noopener noreferrer">Open GTOBase ↗</a>` : ''}
                </div>
                <div id="casino-decision" class="casino-decision" aria-hidden="true">
                    <span class="casino-decision-label">${operator ? 'AI mode' : 'Human solver connected'}</span>
                    <strong>${operator ? 'Waiting for Tyler.' : 'Tell me what happened.'}</strong>
                    <p>${operator ? 'Calculate the exact move in GTOBase, then type the reply below.' : 'Your message is sent to the human solver desk. Their reply will be read aloud.'}</p>
                </div>
                <div id="casino-transcript" class="casino-transcript" aria-hidden="true"></div>
                <div id="casino-recording-status" class="casino-recording-status">${operator ? 'Live inbox connected.' : 'Starting the always-on microphone…'}</div>
                ${operator ? '' : `<div class="casino-call-controls">
                    <button id="casino-speaker-toggle" class="casino-audio-toggle casino-audio-icon ${speakerOn ? '' : 'quiet'}" type="button" aria-label="${speakerOn ? 'Switch to handheld mode' : 'Switch to speakerphone'}" title="${speakerOn ? 'Speakerphone on' : 'Handheld mode'}">${speakerIcon()}</button>
                    <div id="casino-live-mic" class="casino-mic live" aria-label="Microphone always listening"><span>🎙</span><small>Always listening</small></div>
                    <button id="casino-end-call" class="casino-end-call" type="button" aria-label="Hang up" title="Hang up"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 15.2c4.8-3.7 10.2-3.7 15 0l-2.2 3.3c-.3.5-.9.7-1.4.4l-2.2-1.2c-.3-.2-.5-.5-.5-.9v-1.1c-.8-.2-1.6-.2-2.4 0v1.1c0 .4-.2.7-.5.9l-2.2 1.2c-.5.3-1.1.1-1.4-.4l-2.2-3.3Z"/></svg></button>
                </div>`}
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
            heroHand = hand;
            startRingtone();
            screen = 'incoming';
            refresh();
        });
    }

    function bindIncoming() {
        document.getElementById('casino-decline').addEventListener('click', () => { stopRingtone(); reset(); });
        document.getElementById('casino-answer').addEventListener('click', async () => {
            stopRingtone();
            unlockAudio();
            speechGeneration += 1;
            queuedSpeechIds.clear();
            recentSpeechContent.clear();
            tylerCallStartedAt = new Date().toISOString();
            screen = 'call';
            seenMessageIds.clear();
            refresh();
            const listening = startAlwaysOnListening();
            await sendSharedMessage(`New hand: ${heroHand}.`, 'hand');
            const microphoneReady = await listening;
            queueSpeak('What is the action?', `prompt:${tylerCallStartedAt}`);
            if (microphoneReady) updateStatus('What is the action? Listening continuously — each pause sends your words.');
        });
    }

    function bindCall() {
        startPolling();
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
            const response = await fetch(`/api/casino/messages?limit=${roleMode === 'operator' ? 5000 : 200}`);
            if (!response.ok) throw new Error(`Inbox unavailable (${response.status})`);
            const data = await response.json();
            const messages = Array.isArray(data.messages) ? data.messages : [];
            const newReplies = [];
            for (const message of messages) {
                if (!message.id || seenMessageIds.has(message.id)) continue;
                seenMessageIds.add(message.id);
                if (roleMode === 'tyler' && tylerCallStartedAt && message.timestamp < tylerCallStartedAt) continue;
                displayMessage(message);
                if (roleMode === 'tyler' && message.sender === 'operator') newReplies.push(message);
            }
            const newestReply = newReplies[newReplies.length - 1];
            if (newestReply) {
                queueSpeak(newestReply.content, newestReply.id, true);
                updateStatus(`${newReplies.length > 1 ? `${newReplies.length} AI replies` : 'AI replied'} — speaking now.`);
            }
        } catch (error) {
            updateStatus(error.message);
        }
    }

    function sendSharedMessage(text, kind) {
        const sender = roleMode;
        const task = messageSendChain.then(() => postSharedMessage(text, kind, sender));
        messageSendChain = task.catch(() => {});
        return task;
    }

    async function postSharedMessage(text, kind, sender) {
        busy = true;
        updateStatus(sender === 'operator' ? 'Sending exact reply…' : 'Sending to human solver…', true);
        try {
            const response = await fetch('/api/casino/messages', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sender, content: text, kind })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || `Send failed (${response.status})`);
            if (data.message && !seenMessageIds.has(data.message.id)) {
                seenMessageIds.add(data.message.id);
                displayMessage(data.message);
            }
            updateStatus(sender === 'operator' ? 'Reply delivered to Tyler.' : 'Delivered. Waiting for the human solver.');
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

    function displayMessage(message) {
        const sender = message.sender === 'operator' ? 'operator' : 'tyler';
        addMessage(message.content, sender === roleMode ? 'self' : 'remote', sender === 'operator' ? 'AI' : 'Tyler');
    }

    function updateStatus(text, active) {
        const status = document.getElementById('casino-recording-status');
        if (status) { status.textContent = text; status.classList.toggle('active', Boolean(active)); }
    }

    async function startAlwaysOnListening() {
        if (roleMode !== 'tyler' || !navigator.mediaDevices || !window.MediaRecorder) {
            updateStatus('Continuous voice is unavailable here. Type the action below.');
            return false;
        }
        releaseStream();
        alwaysListening = true;
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) throw new Error('Audio level detection is unavailable');
            audioContext = new AudioContextClass();
            if (audioContext.state === 'suspended') await audioContext.resume();
            const source = audioContext.createMediaStreamSource(mediaStream);
            audioAnalyser = audioContext.createAnalyser();
            audioAnalyser.fftSize = 512;
            audioAnalyser.smoothingTimeConstant = 0.35;
            vadSamples = new Uint8Array(audioAnalyser.fftSize);
            source.connect(audioAnalyser);
            noiseFloor = 0.012;
            monitorVoiceActivity();
            setLiveMicState('listening');
            updateStatus('Microphone is always on. Speak naturally; a short pause sends each transcription.');
            return true;
        } catch (error) {
            console.warn('Casino microphone error:', error && error.name, error && error.message);
            const blocked = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
            updateStatus(blocked
                ? 'Microphone is blocked for Business World. Open this site’s browser settings, set Microphone to Allow, hang up, and answer again.'
                : 'The microphone could not start. Close other apps using it, hang up, and answer again.');
            releaseStream();
            return false;
        }
    }

    function monitorVoiceActivity() {
        if (!alwaysListening || !audioAnalyser || !vadSamples) return;
        audioAnalyser.getByteTimeDomainData(vadSamples);
        let sum = 0;
        for (const sample of vadSamples) {
            const normalized = (sample - 128) / 128;
            sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / vadSamples.length);
        const threshold = Math.max(0.018, noiseFloor * 2.35);
        const now = Date.now();

        if (isSpeakingReply) {
            if (mediaRecorder && mediaRecorder.state === 'recording') finishVoiceSegment();
            setLiveMicState('paused');
        } else if (rms > threshold) {
            if (!mediaRecorder) startVoiceSegment();
            lastVoiceAt = now;
            setLiveMicState('speaking');
        } else {
            if (!mediaRecorder) noiseFloor = Math.max(0.006, Math.min(0.025, noiseFloor * 0.97 + rms * 0.03));
            if (mediaRecorder && mediaRecorder.state === 'recording' && now - lastVoiceAt > 900 && now - voiceStartedAt > 450) finishVoiceSegment();
            if (!mediaRecorder) setLiveMicState('listening');
        }
        if (mediaRecorder && mediaRecorder.state === 'recording' && now - voiceStartedAt > 15000) finishVoiceSegment();
        vadFrame = requestAnimationFrame(monitorVoiceActivity);
    }

    function startVoiceSegment() {
        if (!mediaStream || !alwaysListening || isSpeakingReply) return;
        const chunks = [];
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
            : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
                : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
        const recorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
        mediaRecorder = recorder;
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = () => {
            if (mediaRecorder === recorder) mediaRecorder = null;
            if (chunks.length && alwaysListening) {
                const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
                transcriptionChain = transcriptionChain.then(() => transcribeVoiceSegment(blob)).catch(() => {});
            }
        };
        recorder.onerror = () => { if (mediaRecorder === recorder) mediaRecorder = null; };
        voiceStartedAt = Date.now();
        lastVoiceAt = voiceStartedAt;
        recorder.start(250);
    }

    function finishVoiceSegment() {
        if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
        try { mediaRecorder.stop(); } catch (error) {}
        updateStatus('Pause detected — transcribing while the microphone stays on.', true);
    }

    async function transcribeVoiceSegment(blob) {
        try {
            const audio = await blobToBase64(blob);
            const response = await fetch('/api/openai/transcribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audio, mimeType: blob.type })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Transcription failed');
            const text = String(result.text || '').trim();
            if (text) await sendSharedMessage(text, 'message');
            if (alwaysListening && !isSpeakingReply) updateStatus('Sent. Still listening — keep talking whenever you need to.');
        } catch (error) {
            addMessage(`Voice error: ${error.message}`, 'error', 'System');
            if (alwaysListening) updateStatus('That phrase did not send. The microphone is still listening.');
        }
    }

    function setLiveMicState(state) {
        const mic = document.getElementById('casino-live-mic');
        if (!mic) return;
        mic.classList.toggle('recording', state === 'speaking');
        mic.classList.toggle('paused', state === 'paused');
        const label = mic.querySelector('small');
        if (label) label.textContent = state === 'speaking' ? 'Hearing you' : state === 'paused' ? 'Reply playing' : 'Always listening';
    }

    function startRingtone() {
        stopRingtone();
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        try {
            ringContext = new AudioContextClass();
            if (ringContext.state === 'suspended') ringContext.resume().catch(() => {});
            const pulse = () => {
                if (!ringContext || ringContext.state === 'closed') return;
                const gain = ringContext.createGain();
                const firstTone = ringContext.createOscillator();
                const secondTone = ringContext.createOscillator();
                firstTone.frequency.value = 440;
                secondTone.frequency.value = 480;
                firstTone.connect(gain);
                secondTone.connect(gain);
                gain.connect(ringContext.destination);
                const now = ringContext.currentTime;
                gain.gain.setValueAtTime(0.0001, now);
                gain.gain.exponentialRampToValueAtTime(0.12, now + 0.03);
                gain.gain.setValueAtTime(0.12, now + 0.55);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
                firstTone.start(now);
                secondTone.start(now);
                firstTone.stop(now + 0.72);
                secondTone.stop(now + 0.72);
                ringStops.push(firstTone, secondTone);
                setTimeout(() => { ringStops = ringStops.filter(tone => tone !== firstTone && tone !== secondTone); }, 800);
            };
            pulse();
            ringTimer = setInterval(pulse, 1600);
            if (navigator.vibrate) navigator.vibrate([350, 200, 350]);
        } catch (error) {}
    }

    function stopRingtone() {
        if (ringTimer) clearInterval(ringTimer);
        ringTimer = null;
        for (const oscillator of ringStops) { try { oscillator.stop(); } catch (error) {} }
        ringStops = [];
        if (ringContext) { try { ringContext.close(); } catch (error) {} }
        ringContext = null;
        if (navigator.vibrate) navigator.vibrate(0);
    }

    function unlockAudio() {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass && !playbackContext) {
            try {
                playbackContext = new AudioContextClass();
                if (playbackContext.state === 'suspended') playbackContext.resume().catch(() => {});
                const silentSource = playbackContext.createBufferSource();
                silentSource.buffer = playbackContext.createBuffer(1, 1, 22050);
                silentSource.connect(playbackContext.destination);
                silentSource.start(0);
            } catch (error) { playbackContext = null; }
        }
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
        if (button) {
            button.innerHTML = speakerIcon();
            button.classList.toggle('quiet', !speakerOn);
            button.setAttribute('aria-label', speakerOn ? 'Switch to handheld mode' : 'Switch to speakerphone');
            button.title = speakerOn ? 'Speakerphone on' : 'Handheld mode';
        }
        updateStatus(speakerOn ? 'Speakerphone is on.' : 'Handheld mode is on. Hold the phone to your ear.');
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

    function queueSpeak(text, messageId, isAiReply = false) {
        if (messageId && queuedSpeechIds.has(messageId)) return;
        if (isAiReply && aiReplyQueuedOrPlaying) return;
        const normalized = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const now = Date.now();
        for (const [content, queuedAt] of recentSpeechContent) {
            if (now - queuedAt > 30000) recentSpeechContent.delete(content);
        }
        if (normalized && recentSpeechContent.has(normalized)) return;
        if (messageId) queuedSpeechIds.add(messageId);
        if (normalized) recentSpeechContent.set(normalized, now);
        if (isAiReply) aiReplyQueuedOrPlaying = true;
        const generation = speechGeneration;
        speechChain = speechChain
            .then(() => generation === speechGeneration ? speak(text, generation) : undefined)
            .catch(() => {})
            .finally(() => { if (isAiReply) aiReplyQueuedOrPlaying = false; });
    }

    async function playTtsBlob(blob) {
        if (playbackContext) {
            try {
                if (playbackContext.state === 'suspended') await playbackContext.resume();
                const audioBuffer = await playbackContext.decodeAudioData(await blob.arrayBuffer());
                const source = playbackContext.createBufferSource();
                const gain = playbackContext.createGain();
                gain.gain.value = speakerOn ? 1 : 0.2;
                source.buffer = audioBuffer;
                source.connect(gain);
                gain.connect(playbackContext.destination);
                playbackSource = source;
                await new Promise((resolve, reject) => {
                    source.onended = resolve;
                    try { source.start(0); } catch (error) { reject(error); }
                });
                if (playbackSource === source) playbackSource = null;
                return;
            } catch (error) { playbackSource = null; }
        }
        const url = URL.createObjectURL(blob);
        ttsAudio.pause();
        ttsAudio.src = url;
        ttsAudio.volume = speakerOn ? 1 : 0.2;
        await new Promise((resolve, reject) => {
            ttsAudio.onended = () => { URL.revokeObjectURL(url); ttsAudio.src = ''; resolve(); };
            ttsAudio.onerror = reject;
            ttsAudio.play().catch(reject);
        });
    }

    async function speak(text, generation) {
        if (roleMode !== 'tyler' || generation !== speechGeneration) return;
        isSpeakingReply = true;
        if (mediaRecorder && mediaRecorder.state === 'recording') finishVoiceSegment();
        setLiveMicState('paused');
        updateStatus('AI is speaking…', true);
        try {
            await applyAudioMode(false);
            const response = await fetch('/api/openai/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: text, voice: 'alloy', speed: 1.3 }) });
            if (!response.ok) throw new Error('TTS unavailable');
            if (generation !== speechGeneration) return;
            await playTtsBlob(await response.blob());
        } catch (error) {
            if (generation === speechGeneration) updateStatus('AI voice playback failed. The reply is still visible on screen.');
        } finally {
            if (generation === speechGeneration) {
                isSpeakingReply = false;
                lastVoiceAt = Date.now();
                if (alwaysListening) {
                    setLiveMicState('listening');
                    updateStatus('Still listening — keep talking whenever you need to.');
                }
            }
        }
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onloadend = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
    }

    function releaseStream() {
        alwaysListening = false;
        if (vadFrame) cancelAnimationFrame(vadFrame);
        vadFrame = null;
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.onstop = null;
            try { mediaRecorder.stop(); } catch (error) {}
        }
        mediaRecorder = null;
        if (audioContext) { try { audioContext.close(); } catch (error) {} }
        audioContext = null;
        audioAnalyser = null;
        vadSamples = null;
        if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    function reset() {
        speechGeneration += 1;
        speechChain = Promise.resolve();
        releaseAudio();
        stopPolling();
        screen = 'entry';
        tylerCallStartedAt = '';
        seenMessageIds.clear();
        queuedSpeechIds.clear();
        recentSpeechContent.clear();
        aiReplyQueuedOrPlaying = false;
        refresh();
    }

    function releaseAudio() {
        stopRingtone();
        releaseStream();
        isSpeakingReply = false;
        aiReplyQueuedOrPlaying = false;
        if (playbackSource) { try { playbackSource.stop(); } catch (error) {} }
        playbackSource = null;
        if (playbackContext) { try { playbackContext.close(); } catch (error) {} }
        playbackContext = null;
        if (ttsAudio) { ttsAudio.pause(); ttsAudio.src = ''; }
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }

    function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }

    return {
        open(bodyEl) {
            container = bodyEl;
            try { roleMode = localStorage.getItem(ROLE_KEY) === 'operator' ? 'operator' : 'tyler'; } catch (error) { roleMode = 'tyler'; }
            try { speakerOn = localStorage.getItem(SPEAKER_KEY) !== 'no'; } catch (error) { speakerOn = true; }
            screen = roleMode === 'operator' ? 'call' : 'entry';
            refresh();
        },
        close() { releaseAudio(); stopPolling(); if (container) container.innerHTML = ''; container = null; }
    };
})();

window.CasinoUI = CasinoUI;

BuildingRegistry.register('Casino', { open: bodyEl => CasinoUI.open(bodyEl), close: () => CasinoUI.close() });
