/**
 * Storage UI — panel rendering, voice I/O, chat, suggestion handling.
 * Ported from StorageAI/src/ui/main_window.py and sorting_logic.py
 */
const StorageUI = (() => {
    let container = null;
    let chatLog = null;
    let initialized = false;
    let micState = 'idle'; // idle | recording | processing
    let recognition = null; // Web Speech API instance
    let ttsAudio = null; // current TTS audio element

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
                        <button class="sync-btn" onclick="StorageUI.onSync()">Sync</button>
                        <button class="sync-btn" onclick="StorageUI.onReindex()">Re-index</button>
                    </div>
                    <div class="storage-boxes-grid" id="storage-boxes-grid">
                        <div class="storage-loading"><div class="storage-spinner"></div></div>
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

    // --- Voice I/O ---
    function setMicState(state) {
        micState = state;
        const btn = document.getElementById('storage-mic-btn');
        if (!btn) return;
        btn.classList.remove('recording', 'processing');
        if (state === 'recording') btn.classList.add('recording');
        if (state === 'processing') btn.classList.add('processing');
    }

    function initSpeechRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) return null;
        const rec = new SpeechRecognition();
        rec.continuous = false;
        rec.interimResults = false;
        rec.lang = 'en-US';
        rec.onresult = async (event) => {
            const transcript = event.results[0][0].transcript;
            setMicState('processing');
            addChatMsg(transcript, 'user');
            await processUserInput(transcript);
            setMicState('idle');
        };
        rec.onerror = (event) => {
            if (event.error !== 'aborted') {
                addChatMsg(`Voice error: ${event.error}`, 'error');
            }
            setMicState('idle');
        };
        rec.onend = () => {
            if (micState === 'recording') setMicState('idle');
        };
        return rec;
    }

    async function speakTTS(text) {
        // Try OpenAI TTS first for high-quality voice
        try {
            const res = await fetch('https://api.openai.com/v1/audio/speech', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${CONFIG.openai.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: CONFIG.openai.ttsModel,
                    voice: CONFIG.openai.ttsVoice,
                    input: text
                })
            });
            if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }
                ttsAudio = new Audio(url);
                ttsAudio.play();
                ttsAudio.onended = () => URL.revokeObjectURL(url);
                return;
            }
        } catch (e) {
            console.warn('OpenAI TTS failed, falling back to browser TTS:', e.message);
        }
        // Fallback to browser TTS
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
                    const msg = r.deleted
                        ? `Removed all ${r.item.name}.`
                        : `Removed ${parsed.quantity || 1}x ${r.item.name}. ${r.item.quantity} remaining.`;
                    addChatMsg(msg, 'system');
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
                    await speakTTS(msg);
                    break;
                }
                case 'REMOVE_BOX': {
                    const r = await StorageService.removeBox(parsed.boxName);
                    if (r.error) { addChatMsg(r.error, 'error'); return; }
                    const msg = `Removed box ${r.box.name}.`;
                    addChatMsg(msg, 'system');
                    await speakTTS(msg);
                    break;
                }
                case 'CLEAR_BOX': {
                    const r = await StorageService.clearBox(parsed.boxName);
                    if (r.error) { addChatMsg(r.error, 'error'); return; }
                    const msg = `Cleared ${r.count} items from box ${r.box.name}.`;
                    addChatMsg(msg, 'system');
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
            recognition = initSpeechRecognition();

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
            if (recognition) { try { recognition.abort(); } catch (e) {} }
            if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            container = null;
            initialized = false;
        },

        onMicToggle() {
            if (!recognition) {
                addChatMsg('Voice input not supported in this browser.', 'error');
                return;
            }
            if (micState === 'recording') {
                recognition.stop();
                setMicState('idle');
            } else if (micState === 'idle') {
                setMicState('recording');
                recognition.start();
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

        async onReindex() {
            addChatMsg('Re-indexing vector database...', 'system');
            try {
                await StorageService.sync();
                await StorageService.reindexAll((msg) => addChatMsg(msg, 'system'));
                renderBoxes();
                updateStats();
            } catch (e) {
                addChatMsg(`Re-index error: ${e.message}`, 'error');
            }
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

        async onChatSend() {
            const input = document.getElementById('storage-chat-input');
            if (!input) return;
            const text = input.value.trim();
            if (!text) return;
            input.value = '';
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
