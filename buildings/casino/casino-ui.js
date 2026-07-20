'use strict';

const CasinoUI = (() => {
    let container = null;
    let screen = 'entry';
    let heroHand = '';
    let tableSize = 9;
    let stackBb = 30;
    let actionHistory = [];
    let chatHistory = [];
    let mediaRecorder = null;
    let mediaStream = null;
    let audioChunks = [];
    let recordingStarted = 0;
    let recordingTimer = null;
    let ttsAudio = null;
    let busy = false;

    function render() {
        return `<section class="casino-panel" aria-label="Casino poker coach">
            ${screen === 'entry' ? renderEntry() : screen === 'incoming' ? renderIncoming() : renderCall()}
        </section>`;
    }

    function renderHeader(subtitle) {
        return `<header class="casino-toolbar">
            <span class="casino-chip" aria-hidden="true">♠</span>
            <div class="casino-heading"><h2>Casino</h2><p>${subtitle}</p></div>
            <span class="casino-mode-badge">AI estimate</span>
        </header>`;
    }

    function renderEntry() {
        return `${renderHeader('Mobile poker coach')}
            <main class="casino-entry">
                <div class="casino-table" aria-hidden="true">
                    <span class="casino-card casino-card-one">A♠</span>
                    <span class="casino-card casino-card-two">K♠</span>
                    <span class="casino-table-chip">GTO</span>
                </div>
                <div class="casino-copy">
                    <span class="casino-eyebrow">Start a hand</span>
                    <h3>What are your cards?</h3>
                    <p>Enter your hole cards. Your poker coach will call immediately, then you can explain the action by voice.</p>
                </div>
                <form id="casino-hand-form" class="casino-hand-form">
                    <label for="casino-hand-input">Hole cards</label>
                    <input id="casino-hand-input" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" maxlength="40" placeholder="Example: A♠ K♠ or ace king suited" required>
                    <div class="casino-segment" role="group" aria-label="Table size">
                        <button type="button" data-table-size="9" class="active">9-max</button>
                        <button type="button" data-table-size="8">8-max</button>
                    </div>
                    <label for="casino-stack-input">Your stack (bb)</label>
                    <input id="casino-stack-input" type="number" inputmode="decimal" min="1" max="300" step="0.5" value="30" required>
                    <p id="casino-entry-error" class="casino-form-error" role="alert"></p>
                    <button class="casino-primary" type="submit"><span>Call poker coach</span><span aria-hidden="true">☎</span></button>
                </form>
                <p class="casino-disclaimer">Private assistant for practice and video production. Current advice is an AI estimate, not a direct GTOBase result.</p>
            </main>`;
    }

    function renderIncoming() {
        return `<main class="casino-incoming">
            <div class="casino-call-avatar" aria-hidden="true">♠</div>
            <span class="casino-call-label">Incoming call</span>
            <h2>Poker Coach</h2>
            <p>${escapeHtml(heroHand)} · ${tableSize}-max · ${formatNumber(stackBb)}bb</p>
            <div class="casino-call-actions">
                <button id="casino-decline" class="casino-call-button decline" type="button"><span>×</span><small>Decline</small></button>
                <button id="casino-answer" class="casino-call-button answer" type="button"><span>☎</span><small>Answer</small></button>
            </div>
        </main>`;
    }

    function renderCall() {
        return `${renderHeader('Poker Coach · connected')}
            <main class="casino-call">
                <div class="casino-call-topline">
                    <div><strong>${escapeHtml(heroHand)}</strong><span>${tableSize}-max · ${formatNumber(stackBb)}bb actual</span></div>
                    <span id="casino-solver-stack" class="casino-stack-pill">${formatNumber(CasinoAgent.nearestStack(tableSize, stackBb))}bb ref</span>
                </div>
                <div id="casino-decision" class="casino-decision" aria-live="polite">
                    <span class="casino-decision-label">Coach connected</span>
                    <strong>Tell me what happened.</strong>
                    <p>Include your position, all action before you, and the effective stack.</p>
                </div>
                <div id="casino-transcript" class="casino-transcript" aria-live="polite"></div>
                <div id="casino-recording-status" class="casino-recording-status">Tap the microphone or type the action.</div>
                <div class="casino-call-controls">
                    <button id="casino-mic" class="casino-mic" type="button" aria-label="Start recording"><span>🎙</span><small>Tap to talk</small></button>
                    <button id="casino-end-call" class="casino-end-call" type="button" aria-label="End call">×</button>
                </div>
                <form id="casino-action-form" class="casino-action-form">
                    <input id="casino-action-input" type="text" autocomplete="off" placeholder="Type the action instead…">
                    <button type="submit" aria-label="Send action">↑</button>
                </form>
            </main>`;
    }

    function bind() {
        if (screen === 'entry') bindEntry();
        else if (screen === 'incoming') bindIncoming();
        else bindCall();
    }

    function bindEntry() {
        const form = document.getElementById('casino-hand-form');
        const buttons = container.querySelectorAll('[data-table-size]');
        buttons.forEach(button => button.addEventListener('click', () => {
            tableSize = Number(button.dataset.tableSize);
            buttons.forEach(item => item.classList.toggle('active', item === button));
            const stack = document.getElementById('casino-stack-input');
            if (stack) stack.value = tableSize === 9 ? '30' : '50';
        }));
        form.addEventListener('submit', event => {
            event.preventDefault();
            const hand = document.getElementById('casino-hand-input').value.trim();
            const stack = Number(document.getElementById('casino-stack-input').value);
            const error = document.getElementById('casino-entry-error');
            if (hand.length < 2 || !Number.isFinite(stack) || stack <= 0) {
                error.textContent = 'Enter your two cards and a valid stack.';
                return;
            }
            heroHand = hand;
            stackBb = stack;
            actionHistory = [];
            chatHistory = [];
            screen = 'incoming';
            refresh();
        });
    }

    function bindIncoming() {
        document.getElementById('casino-decline').addEventListener('click', reset);
        document.getElementById('casino-answer').addEventListener('click', async () => {
            unlockAudio();
            screen = 'call';
            refresh();
            await startRecording();
        });
    }

    function bindCall() {
        document.getElementById('casino-mic').addEventListener('click', () => {
            if (mediaRecorder && mediaRecorder.state === 'recording') stopRecording();
            else startRecording();
        });
        document.getElementById('casino-end-call').addEventListener('click', reset);
        document.getElementById('casino-action-form').addEventListener('submit', event => {
            event.preventDefault();
            const input = document.getElementById('casino-action-input');
            const text = input.value.trim();
            if (!text || busy) return;
            input.value = '';
            processAction(text);
        });
    }

    function refresh() {
        if (!container) return;
        container.innerHTML = render();
        bind();
    }

    function addMessage(text, role) {
        const transcript = document.getElementById('casino-transcript');
        if (!transcript) return;
        const bubble = document.createElement('div');
        bubble.className = `casino-message ${role}`;
        bubble.textContent = text;
        transcript.appendChild(bubble);
        transcript.scrollTop = transcript.scrollHeight;
    }

    function updateStatus(text, active) {
        const status = document.getElementById('casino-recording-status');
        if (status) {
            status.textContent = text;
            status.classList.toggle('active', Boolean(active));
        }
    }

    async function startRecording() {
        if (busy || !navigator.mediaDevices || !window.MediaRecorder) {
            if (!navigator.mediaDevices || !window.MediaRecorder) updateStatus('Voice is unavailable here. Type the action below.');
            return;
        }
        releaseStream();
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
                : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
            mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
            audioChunks = [];
            mediaRecorder.ondataavailable = event => { if (event.data.size) audioChunks.push(event.data); };
            mediaRecorder.onstop = transcribeRecording;
            mediaRecorder.start(250);
            recordingStarted = Date.now();
            setMicVisual(true);
            updateRecordingClock();
            recordingTimer = setInterval(updateRecordingClock, 1000);
        } catch (error) {
            updateStatus('Microphone permission was denied. Type the action below.');
            releaseStream();
        }
    }

    function updateRecordingClock() {
        updateStatus(`Listening… ${Math.floor((Date.now() - recordingStarted) / 1000)}s · tap to send`, true);
    }

    function stopRecording() {
        clearInterval(recordingTimer);
        recordingTimer = null;
        if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
        setMicVisual(false);
        updateStatus('Transcribing…', true);
    }

    async function transcribeRecording() {
        const recorderType = mediaRecorder && mediaRecorder.mimeType || 'audio/webm';
        const chunks = audioChunks.slice();
        audioChunks = [];
        releaseStream();
        if (!chunks.length) { updateStatus('No audio captured. Tap to try again.'); return; }
        try {
            const audio = await blobToBase64(new Blob(chunks, { type: recorderType }));
            const response = await fetch('/api/openai/transcribe', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audio, mimeType: recorderType })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Transcription failed');
            const text = String(result.text || '').trim();
            if (!text) { updateStatus('I did not hear anything. Tap to try again.'); return; }
            await processAction(text);
        } catch (error) {
            addMessage(`Voice error: ${error.message}`, 'error');
            updateStatus('Type the action below or tap to try again.');
        }
    }

    async function processAction(text) {
        if (busy) return;
        busy = true;
        addMessage(text, 'user');
        updateStatus('Coach is calculating…', true);
        actionHistory.push(text);
        try {
            const result = await CasinoAgent.run(text, { heroHand, tableSize, stackBb, actionHistory, chatHistory });
            const responseText = result.needsMoreInfo
                ? (result.followUpQuestion || result.spokenText || 'What action happened before you?')
                : (result.spokenText || result.reason || `Your action this time: ${result.selectedAction}.`);
            chatHistory.push({ role: 'user', content: text }, { role: 'assistant', content: responseText });
            addMessage(responseText, 'assistant');
            showDecision(result);
            await speak(responseText);
            updateStatus('Tap the microphone to continue the hand.');
        } catch (error) {
            actionHistory.pop();
            addMessage(error.message, 'error');
            updateStatus('Coach unavailable. Tap or type to try again.');
        } finally {
            busy = false;
        }
    }

    function showDecision(result) {
        const card = document.getElementById('casino-decision');
        const stack = document.getElementById('casino-solver-stack');
        if (stack) stack.textContent = `${formatNumber(result.solverStackBb)}bb ref`;
        if (!card) return;
        card.classList.toggle('has-action', Boolean(result.selectedAction));
        card.replaceChildren();
        const label = document.createElement('span');
        label.className = 'casino-decision-label';
        label.textContent = result.needsMoreInfo ? 'Need one detail' : 'AI estimate · randomized action';
        const action = document.createElement('strong');
        action.textContent = result.needsMoreInfo ? (result.followUpQuestion || 'Tell me more') : result.selectedAction;
        const detail = document.createElement('p');
        if (result.needsMoreInfo) detail.textContent = 'I will decide after your answer.';
        else {
            const mix = (result.actions || []).map(item => `${item.action} ${Math.round(item.frequency * 100)}%`).join(' · ');
            detail.textContent = `${mix}${Number.isFinite(result.randomRoll) ? ` · RNG ${Math.floor(result.randomRoll * 100) + 1}/100` : ''}`;
        }
        card.append(label, action, detail);
    }

    function setMicVisual(recording) {
        const button = document.getElementById('casino-mic');
        if (!button) return;
        button.classList.toggle('recording', recording);
        button.querySelector('small').textContent = recording ? 'Tap to send' : 'Tap to talk';
    }

    function unlockAudio() {
        if (!ttsAudio) ttsAudio = new Audio();
    }

    async function speak(text) {
        try {
            const response = await fetch('/api/openai/tts', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: text, voice: 'alloy' })
            });
            if (!response.ok) throw new Error('TTS unavailable');
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            if (!ttsAudio) ttsAudio = new Audio();
            ttsAudio.pause();
            ttsAudio.src = url;
            ttsAudio.onended = () => { URL.revokeObjectURL(url); ttsAudio.src = ''; };
            await ttsAudio.play();
        } catch (error) {
            if ('speechSynthesis' in window) {
                window.speechSynthesis.cancel();
                window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
            }
        }
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    function releaseStream() {
        if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
        mediaRecorder = null;
    }

    function reset() {
        releaseAudio();
        screen = 'entry';
        refresh();
    }

    function releaseAudio() {
        clearInterval(recordingTimer);
        recordingTimer = null;
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.onstop = null;
            try { mediaRecorder.stop(); } catch (error) {}
        }
        releaseStream();
        if (ttsAudio) { ttsAudio.pause(); ttsAudio.src = ''; }
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
    }

    function formatNumber(value) {
        return Number(value) % 1 ? Number(value).toFixed(1) : String(Number(value));
    }

    return {
        open(bodyEl) { container = bodyEl; screen = 'entry'; refresh(); },
        close() { releaseAudio(); if (container) container.innerHTML = ''; container = null; }
    };
})();

window.CasinoUI = CasinoUI;

BuildingRegistry.register('Casino', {
    open: bodyEl => CasinoUI.open(bodyEl),
    close: () => CasinoUI.close()
});
