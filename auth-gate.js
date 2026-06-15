/**
 * auth-gate.js — Supabase login gate + role-based boot for Business World.
 *
 * Nothing in the app runs until you're signed in and your account has a role:
 *   owner   → the full 3D world (window.__bootApp) + a People admin panel
 *   storage → a standalone Storage room page (no world access)
 *   pending → a "waiting for approval" screen
 *
 * Identity is Supabase (same accounts as jarv1s); roles come from /api/me.
 * Every fetch is auto-stamped with the access token.
 */
(function () {
    let _token = null;            // current Supabase access token
    let supa = null;              // supabase client
    let _account = null;

    // ── 1. Stamp every same-origin request with the bearer token ──
    const _origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        try {
            const urlStr = typeof input === 'string' ? input : (input && input.url) || '';
            const sameOrigin = urlStr.startsWith('/') || urlStr.startsWith(window.location.origin);
            if (_token && sameOrigin) {
                init = init || {};
                const headers = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
                if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + _token);
                init = { ...init, headers };
            }
        } catch (e) { /* fall through to plain fetch */ }
        return _origFetch(input, init);
    };

    // ── tiny DOM helper ──
    const el = (tag, props = {}, html) => { const e = document.createElement(tag); Object.assign(e, props); if (html != null) e.innerHTML = html; return e; };
    function overlay(id) {
        let o = document.getElementById(id);
        if (o) return o;
        o = el('div', { id, className: 'authgate-overlay' });
        document.body.appendChild(o);
        return o;
    }
    function clearOverlays() { document.querySelectorAll('.authgate-overlay').forEach(o => o.remove()); }

    // ── styles ──
    const style = el('style');
    style.textContent = `
    .authgate-overlay { position: fixed; inset: 0; z-index: 100000; display: flex; align-items: center; justify-content: center;
        background: linear-gradient(135deg, #2d5016, #4a8c2a); font-family: 'Nunito', -apple-system, sans-serif; }
    .authgate-card { background: #fff; border-radius: 18px; padding: 34px 30px; width: 92%; max-width: 380px; box-shadow: 0 20px 60px rgba(0,0,0,.35); text-align: center; }
    .authgate-logo { font-family: 'Fredoka One', cursive, sans-serif; font-size: 30px; color: #2d5016; margin: 0 0 4px; }
    .authgate-tag { color: #7a8a6a; font-size: 13px; margin: 0 0 22px; font-weight: 700; }
    .authgate-btn { display: flex; align-items: center; justify-content: center; gap: 9px; width: 100%; border: none; border-radius: 11px;
        padding: 12px; font-size: 15px; font-weight: 800; cursor: pointer; margin-bottom: 10px; font-family: inherit; }
    .authgate-google { background: #fff; color: #3c4043; border: 1.5px solid #dadce0; }
    .authgate-google:hover { background: #f7f8f8; }
    .authgate-primary { background: #00b894; color: #fff; }
    .authgate-primary:hover { background: #00a383; }
    .authgate-input { width: 100%; box-sizing: border-box; border: 1.5px solid #e0dcd6; border-radius: 11px; padding: 11px 13px; font-size: 14px; margin-bottom: 10px; font-family: inherit; }
    .authgate-divider { display: flex; align-items: center; gap: 10px; color: #b3a890; font-size: 12px; font-weight: 700; margin: 14px 0; }
    .authgate-divider::before, .authgate-divider::after { content: ''; flex: 1; height: 1px; background: #eee; }
    .authgate-toggle { font-size: 13px; color: #7a8a6a; margin-top: 6px; }
    .authgate-toggle a { color: #00b894; font-weight: 800; cursor: pointer; text-decoration: none; }
    .authgate-error { color: #e74c3c; font-size: 13px; font-weight: 700; min-height: 18px; margin-top: 4px; }
    .authgate-spinner { width: 40px; height: 40px; border: 4px solid rgba(255,255,255,.3); border-top-color: #fff; border-radius: 50%; animation: authspin 1s linear infinite; }
    @keyframes authspin { to { transform: rotate(360deg); } }
    .authgate-pending { color: #fff; text-align: center; }
    .authgate-pending h2 { font-family: 'Fredoka One', cursive, sans-serif; font-size: 26px; margin: 16px 0 8px; }
    .authgate-pending p { font-size: 15px; opacity: .9; max-width: 320px; margin: 0 auto 18px; line-height: 1.5; }
    .authgate-ghost { background: rgba(255,255,255,.15); color: #fff; border: 1.5px solid rgba(255,255,255,.4); border-radius: 11px; padding: 9px 18px; font-weight: 800; cursor: pointer; font-family: inherit; }
    /* Owner People panel */
    #authgate-people-btn { position: fixed; top: 14px; right: 14px; z-index: 9000; background: rgba(255,255,255,.92); border: 1.5px solid #cdbfa6; border-radius: 12px; padding: 8px 13px; font-weight: 800; font-size: 13px; color: #2d5016; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.18); font-family: inherit; }
    #authgate-people-btn:hover { background: #fff; }
    .authgate-people-modal { background:#fff; border-radius:16px; width:94%; max-width:560px; max-height:84%; display:flex; flex-direction:column; overflow:hidden; }
    .authgate-people-head { display:flex; align-items:center; justify-content:space-between; padding:16px 18px; border-bottom:1px solid #eee; }
    .authgate-people-head h3 { margin:0; font-size:18px; color:#2d5016; }
    .authgate-people-list { overflow-y:auto; padding:8px 0; }
    .authgate-person { display:flex; align-items:center; gap:10px; padding:10px 18px; border-bottom:1px solid #f3efe6; }
    .authgate-person-main { flex:1; min-width:0; }
    .authgate-person-name { font-weight:800; color:#333; font-size:14px; }
    .authgate-person-email { font-size:12px; color:#999; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .authgate-person select { border:1px solid #e0dcd6; border-radius:9px; padding:6px 9px; font-weight:700; font-family:inherit; font-size:13px; }
    .authgate-role-pending { color:#e67e22; } .authgate-role-owner { color:#00b894; } .authgate-role-storage { color:#1565c0; }
    .authgate-storage-shell { position: fixed; inset: 0; z-index: 9000; background: #faf7f2; display: flex; flex-direction: column; }
    .authgate-storage-top { display:flex; align-items:center; justify-content:space-between; padding:10px 16px; background:#2d5016; color:#fff; }
    .authgate-storage-top b { font-family:'Fredoka One',cursive,sans-serif; font-size:16px; }
    .authgate-storage-body { flex:1; min-height:0; overflow:hidden; }
    `;
    document.head.appendChild(style);

    // ── show: a centered spinner ──
    function showLoading(msg) {
        clearOverlays();
        const o = overlay('authgate-loading');
        o.appendChild(el('div', { className: 'authgate-pending' }, `<div class="authgate-spinner" style="margin:0 auto 16px"></div><p>${msg || 'Loading…'}</p>`));
    }

    // ── show: login screen ──
    function showLogin() {
        clearOverlays();
        let mode = 'signin';
        const o = overlay('authgate-login');
        const card = el('div', { className: 'authgate-card' });
        const render = () => {
            card.innerHTML = `
                <div class="authgate-logo">Business World</div>
                <div class="authgate-tag">${mode === 'signin' ? 'Sign in to continue' : 'Create your account'}</div>
                <button class="authgate-btn authgate-google" id="ag-google">
                    <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></svg>
                    Continue with Google
                </button>
                <div class="authgate-divider"><span>or</span></div>
                <input class="authgate-input" id="ag-email" type="email" placeholder="Email address" autocomplete="email">
                <input class="authgate-input" id="ag-pass" type="password" placeholder="Password" autocomplete="current-password">
                <button class="authgate-btn authgate-primary" id="ag-email-btn">${mode === 'signin' ? 'Sign in' : 'Sign up'}</button>
                <div class="authgate-error" id="ag-err"></div>
                <div class="authgate-toggle">${mode === 'signin'
                    ? `New here? <a id="ag-switch">Create an account</a>`
                    : `Have an account? <a id="ag-switch">Sign in</a>`}</div>`;
            card.querySelector('#ag-google').onclick = () => doGoogle();
            card.querySelector('#ag-email-btn').onclick = () => doEmail(mode, card.querySelector('#ag-email').value.trim(), card.querySelector('#ag-pass').value, card.querySelector('#ag-err'));
            card.querySelector('#ag-switch').onclick = () => { mode = mode === 'signin' ? 'signup' : 'signin'; render(); };
            card.querySelector('#ag-pass').onkeydown = (e) => { if (e.key === 'Enter') card.querySelector('#ag-email-btn').click(); };
        };
        render();
        o.appendChild(card);
    }

    async function doGoogle() {
        await supa.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } });
    }
    async function doEmail(mode, email, pass, errEl) {
        errEl.textContent = '';
        if (!email || !pass) { errEl.textContent = 'Enter an email and password.'; return; }
        const fn = mode === 'signin' ? supa.auth.signInWithPassword({ email, password: pass }) : supa.auth.signUp({ email, password: pass });
        const { data, error } = await fn;
        if (error) { errEl.textContent = error.message; return; }
        if (mode === 'signup' && !data.session) { errEl.textContent = 'Check your email to confirm, then sign in.'; return; }
        // session arrives via onAuthStateChange
    }

    // ── show: pending approval ──
    function showPending(email) {
        clearOverlays();
        const o = overlay('authgate-pending');
        const box = el('div', { className: 'authgate-pending' }, `
            <div style="font-size:40px">⏳</div>
            <h2>Waiting for access</h2>
            <p>You're signed in as <b>${email || ''}</b>. Your account is pending approval — the owner will grant you access shortly. This page will let you in automatically once approved.</p>
            <button class="authgate-ghost" id="ag-signout">Sign out</button>`);
        box.querySelector('#ag-signout').onclick = signOut;
        o.appendChild(box);
        // poll every 12s for approval
        if (window.__agPoll) clearInterval(window.__agPoll);
        window.__agPoll = setInterval(refreshRole, 12000);
    }

    async function signOut() {
        if (window.__agPoll) clearInterval(window.__agPoll);
        await supa.auth.signOut();
        _token = null; _account = null;
        location.reload();
    }

    // ── role-based boot ──
    let _booted = false;
    function bootForRole(account) {
        _account = account;
        if (window.__agPoll) clearInterval(window.__agPoll);
        if (account.role === 'pending') { showPending(account.email); return; }
        if (_booted) return; // already in the app
        _booted = true;
        clearOverlays();
        const overlayEl = document.getElementById('loading-overlay');
        if (account.role === 'storage') {
            if (overlayEl) overlayEl.style.display = 'none';
            bootStorageOnly();
        } else { // owner (and any future full-access role)
            if (typeof window.__bootApp === 'function') window.__bootApp();
            mountPeopleButton();
        }
    }

    function bootStorageOnly() {
        const shell = el('div', { className: 'authgate-storage-shell' });
        shell.appendChild(el('div', { className: 'authgate-storage-top' }, `<b>Storage Room</b><button class="authgate-ghost" id="ag-so-out" style="padding:6px 14px">Sign out</button>`));
        const body = el('div', { className: 'authgate-storage-body', id: 'ag-storage-body' });
        shell.appendChild(body);
        document.body.appendChild(shell);
        shell.querySelector('#ag-so-out').onclick = signOut;
        // open the storage building UI standalone
        if (window.StorageUI && window.StorageUI.open) window.StorageUI.open(body);
        else if (window.BuildingRegistry) window.BuildingRegistry.get && window.BuildingRegistry.get('Storage')?.open(body);
    }

    // ── Owner People admin panel ──
    function mountPeopleButton() {
        if (document.getElementById('authgate-people-btn')) return;
        const btn = el('button', { id: 'authgate-people-btn' }, '👥 People');
        btn.onclick = openPeople;
        document.body.appendChild(btn);
        // also a small sign-out in the People panel
    }
    async function openPeople() {
        const o = overlay('authgate-people');
        const modal = el('div', { className: 'authgate-people-modal' });
        modal.innerHTML = `<div class="authgate-people-head"><h3>👥 People &amp; permissions</h3><button class="authgate-ghost" id="ag-people-close" style="padding:6px 12px;background:#eee;color:#555;border-color:#ddd">Close</button></div><div class="authgate-people-list" id="ag-people-list"><div style="padding:20px;text-align:center;color:#999">Loading…</div></div><div style="padding:10px 18px;border-top:1px solid #eee;text-align:right"><button class="authgate-ghost" id="ag-people-signout" style="background:#fdf0ee;color:#c0392b;border-color:#f5c6bd">Sign out</button></div>`;
        o.appendChild(modal);
        o.onclick = (e) => { if (e.target === o) o.remove(); };
        modal.querySelector('#ag-people-close').onclick = () => o.remove();
        modal.querySelector('#ag-people-signout').onclick = signOut;
        const list = modal.querySelector('#ag-people-list');
        try {
            const accts = await (await fetch('/api/accounts')).json();
            if (!Array.isArray(accts)) throw new Error(accts.error || 'failed');
            accts.sort((a, b) => (a.role === 'pending' ? -1 : 1) - (b.role === 'pending' ? -1 : 1) || (a.email || '').localeCompare(b.email || ''));
            list.innerHTML = accts.map(a => `
                <div class="authgate-person" data-id="${a.id}">
                    <div class="authgate-person-main">
                        <div class="authgate-person-name">${a.name || a.email || '(no name)'} ${a.role === 'pending' ? '<span style="color:#e67e22;font-size:11px;font-weight:800">• NEW</span>' : ''}</div>
                        <div class="authgate-person-email">${a.email || ''}</div>
                    </div>
                    <select data-role="${a.id}">
                        ${['pending', 'storage', 'owner'].map(r => `<option value="${r}" ${a.role === r ? 'selected' : ''}>${r === 'pending' ? 'No access' : r === 'storage' ? 'Storage only' : 'Owner (full)'}</option>`).join('')}
                    </select>
                </div>`).join('') || '<div style="padding:20px;text-align:center;color:#999">No accounts yet.</div>';
            list.querySelectorAll('[data-role]').forEach(sel => sel.addEventListener('change', async () => {
                sel.disabled = true;
                const r = await fetch('/api/accounts/' + sel.dataset.role, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: sel.value }) });
                sel.disabled = false;
                if (!r.ok) { const e = await r.json().catch(() => ({})); alert(e.error || 'Could not update role'); }
            }));
        } catch (e) { list.innerHTML = `<div style="padding:20px;text-align:center;color:#e74c3c">${e.message}</div>`; }
    }

    // ── role refresh (after approval / on load) ──
    async function refreshRole() {
        if (!_token) return;
        try {
            const r = await fetch('/api/me');
            if (!r.ok) return;
            const account = await r.json();
            bootForRole(account);
        } catch (e) { /* ignore */ }
    }

    // ── init ──
    async function start() {
        // hide the world's loading overlay until we know the role
        const ov = document.getElementById('loading-overlay');
        if (ov) ov.style.display = 'none';
        showLoading('Signing you in…');
        let cfg;
        try { cfg = await _origFetch('/api/auth/config').then(r => r.json()); }
        catch (e) { showLoading('Auth unavailable. Refresh to retry.'); return; }
        if (!window.supabase || !window.supabase.createClient) { showLoading('Auth library failed to load. Refresh.'); return; }
        supa = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } });

        supa.auth.onAuthStateChange((_event, session) => {
            _token = session?.access_token || null;
            if (!_token) { showLogin(); }
        });

        const { data: { session } } = await supa.auth.getSession();
        _token = session?.access_token || null;
        if (!_token) { showLogin(); return; }
        // clean the OAuth hash from the URL
        if (location.hash.includes('access_token')) history.replaceState(null, '', location.pathname + location.search);
        await refreshRole();
    }

    // wait for supabase CDN + app script
    if (window.supabase) start();
    else window.addEventListener('app-ready', () => start(), { once: true });
})();
