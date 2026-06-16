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
    /* Account section injected into the left slide-out menu */
    #authgate-menu-section h3 { font-family: 'Fredoka One', cursive, sans-serif; color: #8B5E3C; font-size: 18px; margin: 4px 0 8px; }
    .authgate-menu-who { font-size: 12px; color: #998a72; margin-bottom: 10px; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
    .authgate-menu-role { background: #e8f5e9; color: #2e7d32; border-radius: 6px; padding: 1px 7px; font-weight: 800; font-size: 10px; text-transform: uppercase; }
    .authgate-menu-item { display: block; width: 100%; text-align: left; background: #fff; border: 1.5px solid #e0d6c6; border-radius: 10px; padding: 10px 13px; font-size: 14px; font-weight: 800; color: #5a3e1b; cursor: pointer; margin-bottom: 8px; font-family: inherit; }
    .authgate-menu-item:hover { background: #faf5eb; border-color: #cdbfa6; }
    .authgate-menu-item.signout { color: #c0392b; border-color: #f0d0c8; }
    .authgate-menu-item.signout:hover { background: #fdf0ee; }
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
    .authgate-tabs { display:flex; gap:4px; padding:8px 16px 0; border-bottom:1px solid #eee; }
    .authgate-tab { background:none; border:none; border-bottom:2.5px solid transparent; padding:8px 14px; font-size:13px; font-weight:800; color:#999; cursor:pointer; font-family:inherit; }
    .authgate-tab.active { color:#2d5016; border-bottom-color:#2d5016; }
    .authgate-tabbody { overflow-y:auto; flex:1; min-height:0; }
    .authgate-profiles { padding:12px 16px 16px; display:flex; flex-direction:column; gap:12px; }
    .authgate-profile-hint { font-size:12px; color:#998a72; line-height:1.4; }
    .authgate-profile-card { border:1px solid #ece4d6; border-radius:12px; padding:12px 14px; background:#fffdf9; margin-bottom:8px; }
    .authgate-profile-head { display:flex; align-items:center; gap:8px; margin-bottom:8px; cursor:pointer; }
    .authgate-profile-card.collapsed .authgate-profile-head { margin-bottom:0; }
    .authgate-profile-card.collapsed .authgate-profile-body { display:none; }
    .authgate-chev { color:#b09a78; font-size:11px; transition:transform .15s; flex-shrink:0; }
    .authgate-profile-card:not(.collapsed) .authgate-chev { transform:rotate(90deg); }
    .authgate-profile-summary { font-size:11px; font-weight:700; color:#b09a78; white-space:nowrap; flex-shrink:0; }
    .authgate-profile-name { flex:1; border:1px solid #e0dcd6; border-radius:9px; padding:7px 10px; font-size:14px; font-weight:800; color:#5a3e1b; font-family:inherit; }
    .authgate-profile-del { background:#fdf0ee; border:1px solid #f5c6bd; color:#c0392b; border-radius:8px; width:28px; height:28px; cursor:pointer; font-weight:800; flex-shrink:0; }
    .authgate-profile-label { font-size:10.5px; font-weight:800; color:#b09a78; text-transform:uppercase; letter-spacing:.5px; margin:8px 0 5px; }
    .authgate-checkgrid { display:grid; grid-template-columns:1fr 1fr; gap:4px 10px; }
    .authgate-check { display:flex; align-items:center; gap:6px; font-size:12.5px; color:#4a3a26; font-weight:600; cursor:pointer; }
    .authgate-check input { margin:0; }
    .authgate-bldrow { border-bottom:1px solid #f2ece1; padding:5px 0; }
    .authgate-bldcheck { font-size:13px; }
    .authgate-bldhint { font-size:10.5px; font-weight:700; color:#c3ad88; }
    .authgate-subgrid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:2px 8px; margin:3px 0 2px 22px; }
    .authgate-subcheck { display:flex; align-items:center; gap:5px; font-size:11.5px; color:#6a5a44; font-weight:600; cursor:pointer; }
    .authgate-subcheck input { margin:0; }
    .authgate-subcheck input:disabled + * , .authgate-subcheck:has(input:disabled) { opacity:.4; }
    .authgate-stagewrap { margin:4px 0 2px 22px; }
    .authgate-stagehint { font-size:10.5px; font-weight:700; color:#c3ad88; margin-bottom:3px; }
    .authgate-staggrp { font-size:9.5px; font-weight:800; color:#b09a78; text-transform:uppercase; letter-spacing:.4px; margin:6px 0 2px; }
    .authgate-stagerow { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:11.5px; color:#6a5a44; font-weight:600; padding:1px 0; }
    .authgate-stagesel { font-size:11px; padding:1px 4px; border:1px solid #e0d6c5; border-radius:6px; background:#fff; color:#4a3a26; }
    .authgate-stagesel:disabled { opacity:.4; }
    .authgate-menu-greet { font-family:'Fredoka One',cursive,sans-serif; color:#5a3e1b; font-size:18px; margin:2px 0 10px; }
    .authgate-acct-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
    .authgate-acct-lbl { font-size:13px; font-weight:700; color:#6a5a44; flex:1; }
    .authgate-name-input { flex:1; border:1px solid #d8cbb6; border-radius:8px; padding:7px 10px; font-size:13px; font-family:inherit; color:#4a3a26; }
    .authgate-mini { background:#5a3e1b; color:#fff; border:none; border-radius:8px; padding:7px 12px; font-size:12px; font-weight:800; cursor:pointer; }
    .authgate-mini:hover { background:#7a542a; }
    .authgate-color { width:42px; height:30px; border:1px solid #d8cbb6; border-radius:8px; background:none; cursor:pointer; padding:2px; }
    .authgate-profile-foot { display:flex; align-items:center; gap:10px; margin-top:10px; }
    .authgate-pnote { font-size:12px; font-weight:800; }
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
        if (mode === 'signup' && !data.session) { errEl.textContent = "Account created — check your email to confirm, then sign in."; return; }
        // Boot immediately on a successful sign-in (don't wait on the event)
        if (data.session) { _token = data.session.access_token; refreshRole(); }
        else { errEl.textContent = 'Could not start a session. Try again.'; }
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

    // ── boot ── everyone gets the SAME unified world; their profile just hides
    // the buildings / HUD they don't have. owner = full, pending = no access.
    let _booted = false;
    function bootForRole(account) {
        _account = account;
        if (window.__agPoll) clearInterval(window.__agPoll);
        const perms = account.perms || (account.role === 'owner' ? { all: true } : { none: true });
        if (perms.none) { showPending(account.email); return; }
        if (_booted) { if (window.applyAccess) window.applyAccess(perms); return; } // re-apply on refresh
        _booted = true;
        clearOverlays();
        // Re-show the world's loading screen during boot. start() hid it so the
        // login screen was clean; if we don't bring it back, the seconds while the
        // 3D world loads show a BLACK screen (worse on a cold start). init() hides
        // it again when the world is ready.
        const _ld = document.getElementById('loading-overlay'); if (_ld) _ld.style.display = '';
        if (typeof window.__bootApp === 'function') window.__bootApp();
        mountMenuItems();
        applyAccessWhenReady(perms);
        applyPersonalization();
    }

    // Apply the user's own character colour once the player exists, and (owner only)
    // populate Employee Island from the approved accounts (name + colour).
    function applyPersonalization() {
        // Tennille is owner-only — gate her explicitly for whoever is viewing,
        // retrying until the world has built her.
        const isOwner = _account.role === 'owner';
        let gt = 0;
        const gtT = setInterval(() => {
            if (window.gateOwnerOnlyCharacters && window.__tennille) { window.gateOwnerOnlyCharacters(isOwner); clearInterval(gtT); }
            else if (++gt > 60) clearInterval(gtT);
        }, 300);
        if (_account.color) {
            let n = 0;
            const t = setInterval(() => {
                if (window.setPlayerColor && window._bw && window._bw.playerMesh) { window.setPlayerColor(_account.color); clearInterval(t); }
                else if (++n > 40) clearInterval(t);
            }, 300);
        }
        if (_account.role !== 'owner') return;
        window.__myAccountId = _account.id;   // so the island excludes ME (I'm the player)
        window.refreshIslandRoster = async function () {
            let list = [], profiles = [];
            try {
                const bust = '?_=' + Date.now();   // always fetch FRESH (no caching, current data)
                [list, profiles] = await Promise.all([
                    fetch('/api/accounts' + bust).then(r => r.ok ? r.json() : []).catch(() => []),
                    fetch('/api/profiles' + bust).then(r => r.ok ? r.json() : []).catch(() => [])
                ]);
            } catch (e) {}
            list = Array.isArray(list) ? list : [];
            profiles = Array.isArray(profiles) ? profiles : [];
            window.__profiles = profiles;
            if (window.EmployeeService && window.EmployeeService.setFromAccounts) window.EmployeeService.setFromAccounts(list, profiles);
            if (window.syncEmployeeAccounts && window.getBuildingByName && window.getBuildingByName('Employee Island')) {
                window.syncEmployeeAccounts(list, profiles);
                return list.length;   // number of accounts (incl. me)
            }
            return -1;                // island not built yet
        };
        // Retry loop: re-FETCHES each time, so an early 401 (token not ready) or an
        // empty result self-heals once auth lands; stops once we have people + the
        // saved layout has settled the island into place.
        let tries = 0;
        const t = setInterval(async () => {
            const n = await window.refreshIslandRoster();
            if (n > 1 && window.__layoutReady) clearInterval(t);   // got at least one OTHER account
            else if (++tries > 20) clearInterval(t);               // ~40s ceiling
        }, 2000);
    }

    // The 3D world builds asynchronously; hide buildings/HUD as soon as the
    // building objects exist, then once more after everything mounts.
    function applyAccessWhenReady(perms) {
        if (perms.all) return; // owner — nothing to hide
        let tries = 0;
        const t = setInterval(() => {
            if (typeof window.applyAccess === 'function' && window.getBuildingByName && window.getBuildingByName('Storage')) {
                window.applyAccess(perms);
                // Re-apply a few times: paths + building positions stream in from the
                // saved layout AFTER the buildings first appear, so the first pass
                // can't trim the pathways yet.
                [1200, 3000, 6000].forEach(ms => setTimeout(() => window.applyAccess(perms), ms));
                clearInterval(t);
            } else if (++tries > 100) clearInterval(t);
        }, 200);
    }

    function _unusedStorageShell() {
        const shell = el('div', { className: 'authgate-storage-shell' });
        shell.appendChild(el('div', { className: 'authgate-storage-top' }, `<b>Storage Room</b><button class="authgate-ghost" id="ag-so-out" style="padding:6px 14px">Sign out</button>`));
        const body = el('div', { className: 'authgate-storage-body', id: 'ag-storage-body' });
        shell.appendChild(body);
        document.body.appendChild(shell);
        shell.querySelector('#ag-so-out').onclick = signOut;
        if (window.StorageUI && window.StorageUI.open) window.StorageUI.open(body);
        else if (window.BuildingRegistry) window.BuildingRegistry.get && window.BuildingRegistry.get('Storage')?.open(body);
    }

    // ── Account section in the left hamburger menu (People + Sign out) ──
    function mountMenuItems() {
        const panel = document.getElementById('menu-panel');
        if (!panel || document.getElementById('authgate-menu-section')) return;
        const dn = _account.displayName || '', email = _account.email || '';
        const color = /^#[0-9a-fA-F]{6}$/.test(_account.color || '') ? _account.color : '#3498db';
        const roleLabel = (_account.perms && _account.perms.profileName) || _account.role;
        const section = el('div', { id: 'authgate-menu-section' });
        section.innerHTML = `
            <h3>Account</h3>
            <div class="authgate-menu-greet">Hello, <b id="ag-greet"></b> 👋</div>
            <div class="authgate-acct-row">
                <input id="ag-name-input" class="authgate-name-input" maxlength="40">
                <button class="authgate-mini" id="ag-name-save">Save</button>
            </div>
            <div class="authgate-acct-row">
                <span class="authgate-acct-lbl">My character colour</span>
                <input type="color" id="ag-color-input" class="authgate-color">
            </div>
            <div class="authgate-menu-who"><span id="ag-email"></span> <span class="authgate-menu-role" id="ag-rolebadge"></span></div>
            ${_account.role === 'owner' ? '<button class="authgate-menu-item" id="ag-menu-people">👥 People &amp; permissions</button>' : ''}
            <button class="authgate-menu-item signout" id="ag-menu-signout">↩ Sign out</button>
            <div class="divider"></div>`;
        panel.insertBefore(section, panel.children[1] || null);
        // set user-supplied values safely (no HTML injection)
        section.querySelector('#ag-greet').textContent = dn || email || 'there';
        const nameInput = section.querySelector('#ag-name-input'); nameInput.value = dn; nameInput.placeholder = email || 'Set your name';
        const colorInput = section.querySelector('#ag-color-input'); colorInput.value = color;
        section.querySelector('#ag-email').textContent = email;
        section.querySelector('#ag-rolebadge').textContent = roleLabel;
        section.querySelector('#ag-name-save').onclick = async () => {
            const v = nameInput.value.trim(), btn = section.querySelector('#ag-name-save');
            btn.disabled = true; btn.textContent = '…';
            try {
                const r = await fetch('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: v }) });
                if (r.ok) { const u = await r.json(); _account.displayName = u.displayName; section.querySelector('#ag-greet').textContent = u.displayName || email || 'there'; }
            } catch (e) {}
            btn.disabled = false; btn.textContent = 'Saved ✓'; setTimeout(() => btn.textContent = 'Save', 1500);
        };
        colorInput.onchange = async () => {
            const c = colorInput.value;
            if (window.setPlayerColor) window.setPlayerColor(c);
            _account.color = c;
            try { await fetch('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color: c }) }); } catch (e) {}
        };
        const pe = section.querySelector('#ag-menu-people');
        if (pe) pe.onclick = () => { if (window.toggleMenu) window.toggleMenu(); openPeople(); };
        section.querySelector('#ag-menu-signout').onclick = signOut;
    }
    const ALL_BUILDINGS = ['Workshop', 'Storage', 'Money Pit', 'The Pen', 'Employee Island', 'Science Center', 'Jarvis', 'Library', 'Finance', 'The House', 'Movie Theatre', 'Gym', 'Chocolate Bar', 'Video Lab'];
    // Buildings with internal tabs that can be granted individually (mirrors access-registry.js).
    const BUILDING_SECTIONS = (window.ACCESS_REGISTRY
        ? Object.fromEntries(Object.entries(window.ACCESS_REGISTRY).map(([b, r]) => [b, r.sections.map(s => [s.id, s.label])]))
        : {
            Library: [['notes', 'Ideas'], ['freenotes', 'Notes'], ['todo', 'To-Do'], ['calendar', 'Calendar'], ['projects', 'Projects'], ['sponsors', 'Sponsors'], ['ideamap', 'Idea Map'], ['dagflow', 'DAG Flow']],
            Workshop: [['pipeline', 'Pipeline'], ['projects', 'Projects'], ['orders', 'Orders'], ['inventory', 'Storage Room']]
        });
    const escA = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

    async function openPeople() {
        const o = overlay('authgate-people');
        const modal = el('div', { className: 'authgate-people-modal' });
        modal.innerHTML = `
            <div class="authgate-people-head">
                <h3>👥 People &amp; permissions</h3>
                <button class="authgate-ghost" id="ag-people-close" style="padding:6px 12px;background:#eee;color:#555;border-color:#ddd">Close</button>
            </div>
            <div class="authgate-tabs">
                <button class="authgate-tab active" data-tab="people">People</button>
                <button class="authgate-tab" data-tab="profiles">Profiles</button>
            </div>
            <div class="authgate-tabbody" id="ag-tabbody"><div style="padding:24px;text-align:center;color:#999">Loading…</div></div>`;
        o.appendChild(modal);
        o.onclick = (e) => { if (e.target === o) o.remove(); };
        modal.querySelector('#ag-people-close').onclick = () => o.remove();
        const body = modal.querySelector('#ag-tabbody');
        let profiles = [];
        let _expandId = null;   // which profile card is expanded (collapsed by default)
        const loadProfiles = async () => { try { const r = await (await fetch('/api/profiles')).json(); profiles = Array.isArray(r) ? r : []; } catch (e) { profiles = []; } };

        modal.querySelectorAll('.authgate-tab').forEach(t => t.onclick = () => {
            modal.querySelectorAll('.authgate-tab').forEach(x => x.classList.toggle('active', x === t));
            (t.dataset.tab === 'people' ? renderPeople : renderProfiles)();
        });

        async function renderPeople() {
            body.innerHTML = '<div style="padding:24px;text-align:center;color:#999">Loading…</div>';
            await loadProfiles();
            let accts;
            try { accts = await (await fetch('/api/accounts')).json(); if (!Array.isArray(accts)) throw new Error(accts.error || 'failed'); }
            catch (e) { body.innerHTML = `<div style="padding:24px;text-align:center;color:#e74c3c">${escA(e.message)}</div>`; return; }
            accts.sort((a, b) => (a.role === 'pending' ? -1 : 1) - (b.role === 'pending' ? -1 : 1) || (a.email || '').localeCompare(b.email || ''));
            const opts = (cur) => `<option value="pending" ${cur === 'pending' ? 'selected' : ''}>No access</option>` +
                profiles.map(p => `<option value="${escA(p.id)}" ${cur === p.id ? 'selected' : ''}>${escA(p.name)}</option>`).join('') +
                `<option value="owner" ${cur === 'owner' ? 'selected' : ''}>Owner (full)</option>`;
            body.innerHTML = `<div class="authgate-people-list">${accts.length ? accts.map(a => `
                <div class="authgate-person">
                    <div class="authgate-person-main">
                        <div class="authgate-person-name">${escA(a.name || a.email || '(no name)')} ${a.role === 'pending' ? '<span style="color:#e67e22;font-size:11px;font-weight:800">• NEW</span>' : ''}</div>
                        <div class="authgate-person-email">${escA(a.email || '')}</div>
                    </div>
                    <select data-role="${escA(a.id)}">${opts(a.role)}</select>
                </div>`).join('') : '<div style="padding:24px;text-align:center;color:#999">No accounts yet.</div>'}</div>`;
            body.querySelectorAll('[data-role]').forEach(sel => sel.onchange = async () => {
                sel.disabled = true;
                const r = await fetch('/api/accounts/' + sel.dataset.role, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: sel.value }) });
                sel.disabled = false;
                if (!r.ok) { const e = await r.json().catch(() => ({})); alert(e.error || 'Could not update'); }
            });
        }

        function profileCardHtml(p) {
            const b = new Set(p.buildings || []);
            const feats = p.features || {};
            const sectionRows = (name) => {
                const secs = BUILDING_SECTIONS[name];
                if (!secs) return '';
                const granted = b.has(name);
                const keys = Object.keys(feats).filter(k => k.indexOf(name + ':') === 0);
                const noRestriction = keys.length === 0;   // granted whole building → all sections
                const cells = secs.map(([id, lbl]) => {
                    const checked = noRestriction ? true : !!feats[name + ':' + id];
                    return `<label class="authgate-subcheck"><input type="checkbox" data-pfeat="${escA(p.id)}" data-pfbuild="${escA(name)}" value="${escA(name + ':' + id)}" ${checked ? 'checked' : ''} ${granted ? '' : 'disabled'}> ${escA(lbl)}</label>`;
                }).join('');
                return `<div class="authgate-subgrid">${cells}</div>`;
            };
            // Workshop = the pipeline: per-stage None / Read / Read-write.
            const stageRows = () => {
                const stages = window.WORKSHOP_STAGES || [];
                if (!stages.length) return '';
                const granted = b.has('Workshop');
                const groups = [];
                stages.forEach(s => { let g = groups.find(x => x.name === s.group); if (!g) { g = { name: s.group, items: [] }; groups.push(g); } g.items.push(s); });
                const sel = (id) => {
                    const v = feats['Workshop:stage:' + id] || 'none';
                    return `<select class="authgate-stagesel" data-pstage="${escA(p.id)}" data-stageid="${escA(id)}" ${granted ? '' : 'disabled'}>
                        <option value="none" ${v === 'none' ? 'selected' : ''}>None</option>
                        <option value="read" ${v === 'read' ? 'selected' : ''}>Read</option>
                        <option value="write" ${v === 'write' ? 'selected' : ''}>Read-write</option>
                    </select>`;
                };
                return `<div class="authgate-stagewrap">
                    <div class="authgate-stagehint">Pipeline stages (leave all None = full pipeline)</div>
                    ${groups.map(g => `<div class="authgate-staggrp">${escA(g.name)}</div>` +
                        g.items.map(s => `<div class="authgate-stagerow"><span>${escA(s.label)}</span>${sel(s.id)}</div>`).join('')).join('')}
                </div>`;
            };
            // Which sections inside videos / components a profile can see/edit —
            // None / Read / Read-write per field, plus the delete capability.
            const fieldRows = () => {
                const granted = b.has('Workshop');
                const vf = window.VIDEO_FIELDS || [], cf = window.COMPONENT_FIELDS || [];
                if (!vf.length && !cf.length) return '';
                const grp = (title, fields, kind) => {
                    const keys = Object.keys(feats).filter(k => k.indexOf('Workshop:' + kind + ':') === 0);
                    const noRestriction = keys.length === 0;   // no keys = full write everywhere
                    const sel = (id) => {
                        let v = feats['Workshop:' + kind + ':' + id];
                        if (v === true) v = 'write';
                        if (!v) v = noRestriction ? 'write' : 'none';
                        return `<select class="authgate-stagesel" data-pvf="${escA(p.id)}" data-vkind="${kind}" data-vfid="${escA(id)}" ${granted ? '' : 'disabled'}>
                            <option value="none" ${v === 'none' ? 'selected' : ''}>None</option>
                            <option value="read" ${v === 'read' ? 'selected' : ''}>Read</option>
                            <option value="write" ${v === 'write' ? 'selected' : ''}>Read-write</option>
                        </select>`;
                    };
                    return `<div class="authgate-staggrp">${title}</div>` +
                        fields.map(([id, lbl]) => `<div class="authgate-stagerow"><span>${escA(lbl)}</span>${sel(id)}</div>`).join('');
                };
                const delOn = !!feats['Workshop:cap:delete'];
                const capRow = `<div class="authgate-staggrp">Capabilities</div>
                    <div class="authgate-stagerow"><span>Delete things (videos, components, projects…)</span>
                        <select class="authgate-stagesel" data-pcap="${escA(p.id)}" data-capid="delete" ${granted ? '' : 'disabled'}>
                            <option value="off" ${delOn ? '' : 'selected'}>Off</option>
                            <option value="on" ${delOn ? 'selected' : ''}>Allowed</option>
                        </select></div>`;
                return `<div class="authgate-stagewrap">
                    <div class="authgate-stagehint">Sections inside videos / components — None hides it, Read shows it locked, Read-write lets them edit. (Leave all at Read-write = full access.)</div>
                    ${grp('Video sections', vf, 'vfield')}${grp('Component sections', cf, 'cfield')}${capRow}
                </div>`;
            };
            const summary = b.size ? (b.size + ' building' + (b.size === 1 ? '' : 's')) : 'no access';
            const open = (p.id === _expandId);
            return `<div class="authgate-profile-card${open ? '' : ' collapsed'}" data-pcard="${escA(p.id)}">
                <div class="authgate-profile-head" data-ptoggle="${escA(p.id)}">
                    <span class="authgate-chev">▸</span>
                    <input class="authgate-profile-name" data-pname="${escA(p.id)}" value="${escA(p.name || '')}" placeholder="Profile name" onclick="event.stopPropagation()">
                    <span class="authgate-profile-summary">${summary}</span>
                    <button class="authgate-profile-del" data-pdel="${escA(p.id)}" onclick="event.stopPropagation()">✕</button>
                </div>
                <div class="authgate-profile-body">
                    <div class="authgate-profile-label">Buildings &amp; what they can see inside</div>
                    ${ALL_BUILDINGS.map(name => `<div class="authgate-bldrow">
                        <label class="authgate-check authgate-bldcheck"><input type="checkbox" data-pbuild="${escA(p.id)}" value="${escA(name)}" ${b.has(name) ? 'checked' : ''}> <strong>${escA(name)}</strong>${name === 'Workshop' ? ' <span class="authgate-bldhint">— pick stage access below</span>' : (BUILDING_SECTIONS[name] ? ' <span class="authgate-bldhint">— pick tabs below</span>' : '')}</label>
                        ${name === 'Workshop' ? (stageRows() + fieldRows()) : sectionRows(name)}
                    </div>`).join('')}
                    <div class="authgate-profile-foot"><button class="authgate-menu-item" style="margin:0;width:auto" data-psave="${escA(p.id)}">Save</button><span class="authgate-pnote" id="ag-pnote-${escA(p.id)}"></span></div>
                </div>
            </div>`;
        }
        async function renderProfiles(expandId) {
            _expandId = expandId || null;
            body.innerHTML = '<div style="padding:24px;text-align:center;color:#999">Loading…</div>';
            await loadProfiles();
            body.innerHTML = `<div class="authgate-profiles">
                <button class="authgate-menu-item" id="ag-new-profile" style="margin:0 0 8px">＋ New profile</button>
                <div class="authgate-profile-hint">A profile is a reusable permission set. Click one to expand and edit which buildings + sections it grants, then assign it to people on the People tab.</div>
                ${profiles.map(profileCardHtml).join('')}
            </div>`;
            body.querySelector('#ag-new-profile').onclick = async () => {
                const r = await fetch('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'New profile', buildings: [], features: {} }) });
                const np = await r.json().catch(() => null);
                renderProfiles(np && np.id);   // open the new one
            };
            // collapse/expand a profile card by clicking its header
            body.querySelectorAll('[data-ptoggle]').forEach(h => h.onclick = () => h.closest('.authgate-profile-card').classList.toggle('collapsed'));
            // toggling a building enables/disables its section checkboxes
            body.querySelectorAll('[data-pbuild]').forEach(cb => cb.onchange = () => {
                const pid = cb.dataset.pbuild, name = cb.value;
                body.querySelectorAll(`[data-pfeat="${CSS.escape(pid)}"][data-pfbuild="${CSS.escape(name)}"]`).forEach(s => { s.disabled = !cb.checked; if (cb.checked) s.checked = true; });
                if (name === 'Workshop') {
                    body.querySelectorAll(`[data-pstage="${CSS.escape(pid)}"]`).forEach(s => { s.disabled = !cb.checked; });
                    body.querySelectorAll(`[data-pvf="${CSS.escape(pid)}"]`).forEach(s => { s.disabled = !cb.checked; });
                    body.querySelectorAll(`[data-pcap="${CSS.escape(pid)}"]`).forEach(s => { s.disabled = !cb.checked; });
                }
            });
            body.querySelectorAll('[data-psave]').forEach(btn => btn.onclick = async () => {
                const pid = btn.dataset.psave;
                const name = body.querySelector(`[data-pname="${CSS.escape(pid)}"]`).value.trim() || 'Untitled profile';
                const buildings = [...body.querySelectorAll(`[data-pbuild="${CSS.escape(pid)}"]:checked`)].map(c => c.value);
                const features = {}; body.querySelectorAll(`[data-pfeat="${CSS.escape(pid)}"]:checked`).forEach(c => { if (buildings.includes(c.dataset.pfbuild)) features[c.value] = true; });
                if (buildings.includes('Workshop')) {
                    // Stage access: store granted (read/write) stages. If NONE are
                    // granted the profile gets full pipeline (back-compat) — to scope
                    // someone to specific nodes, set those to Read/Read-write and
                    // leave the rest None (at least one must be granted).
                    body.querySelectorAll(`[data-pstage="${CSS.escape(pid)}"]`).forEach(s => { if (s.value !== 'none') features['Workshop:stage:' + s.dataset.stageid] = s.value; });
                    // Field access: store read/write; omit 'write' default ONLY when ALL are write (then no keys = full).
                    const fieldSels = [...body.querySelectorAll(`[data-pvf="${CSS.escape(pid)}"]`)];
                    const anyRestricted = fieldSels.some(s => s.value !== 'write');
                    if (anyRestricted) fieldSels.forEach(s => { features['Workshop:' + s.dataset.vkind + ':' + s.dataset.vfid] = s.value; });
                    body.querySelectorAll(`[data-pcap="${CSS.escape(pid)}"]`).forEach(s => { if (s.value === 'on') features['Workshop:cap:' + s.dataset.capid] = true; });
                }
                btn.disabled = true; btn.textContent = 'Saving…';
                const r = await fetch('/api/profiles/' + pid, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, buildings, features }) });
                btn.disabled = false; btn.textContent = 'Save';
                const note = document.getElementById('ag-pnote-' + pid); if (note) { note.textContent = r.ok ? 'Saved ✓' : 'Failed'; note.style.color = r.ok ? '#27ae60' : '#e74c3c'; setTimeout(() => note.textContent = '', 2500); }
            });
            body.querySelectorAll('[data-pdel]').forEach(btn => btn.onclick = async () => {
                if (!confirm('Delete this profile? Anyone using it loses access until reassigned.')) return;
                await fetch('/api/profiles/' + btn.dataset.pdel, { method: 'DELETE' });
                renderProfiles();
            });
        }
        renderPeople();
    }

    // ── role refresh (after approval / on load) ──
    async function refreshRole(attempt) {
        if (!_token) return;
        attempt = attempt || 0;
        try {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 25000);   // generous — Render free tier cold-starts slowly
            const r = await fetch('/api/me', { signal: ctrl.signal });
            clearTimeout(to);
            if (!r.ok) throw new Error('me ' + r.status);
            const account = await r.json();
            bootForRole(account);
        } catch (e) {
            // Transient (cold start / blip): retry instead of hanging on "Signing you in…".
            if (!_booted && attempt < 6) {
                showLoading(attempt ? 'Waking the server up…' : 'Signing you in…');
                setTimeout(() => refreshRole(attempt + 1), 2500);
            } else if (!_booted) {
                showStuck();
            }
        }
    }
    // Last resort if the server never answers — offer a reload instead of a dead screen.
    function showStuck() {
        clearOverlays();
        const o = overlay('authgate-loading');
        const card = el('div', { className: 'authgate-pending' }, `<p style="margin-bottom:14px">Couldn't reach the server.</p><button class="authgate-menu-item" id="ag-reload" style="width:auto">↻ Reload</button>`);
        o.appendChild(card);
        const btn = card.querySelector('#ag-reload'); if (btn) btn.onclick = () => location.reload();
    }

    // ── init ──
    async function start() {
        // hide the world's loading overlay until we know the role
        const ov = document.getElementById('loading-overlay');
        if (ov) ov.style.display = 'none';
        showLoading('Signing you in…');
        // Watchdog: if we're still stuck on a loading/sign-in screen and never booted
        // (auth hang of any kind), surface a Reload instead of a permanent dead screen.
        setTimeout(() => { if (!_booted && document.getElementById('authgate-loading') && !document.getElementById('ag-reload')) showStuck(); }, 40000);
        let cfg;
        try { cfg = await _origFetch('/api/auth/config').then(r => r.json()); }
        catch (e) { showLoading('Auth unavailable. Refresh to retry.'); return; }
        if (!window.supabase || !window.supabase.createClient) { showLoading('Auth library failed to load. Refresh.'); return; }
        supa = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } });

        // React to sign-in / sign-out / token refresh. A token arriving (e.g.
        // after email or Google sign-in) must actually BOOT the app — not just
        // store the token. (This was the "can't log back in with email" bug.)
        supa.auth.onAuthStateChange((event, session) => {
            _token = session?.access_token || null;
            if (_token) refreshRole();
            else if (event === 'SIGNED_OUT') showLogin();
        });

        const { data: { session } } = await supa.auth.getSession();
        _token = session?.access_token || null;
        if (!_token) { showLogin(); return; }
        // clean the OAuth hash from the URL
        if (location.hash.includes('access_token')) history.replaceState(null, '', location.pathname + location.search);
        await refreshRole();
    }

    // Don't start until BOTH the Supabase lib AND the app's boot entry point exist.
    // The app is a deferred ES module, so window.__bootApp can be defined LATER than
    // this (regular) script runs — starting too early meant bootForRole called an
    // undefined __bootApp and the world never loaded (the "reload to fix" bug).
    let _waited = 0;
    (function go() {
        const supaReady = window.supabase && window.supabase.createClient;
        const appReady = typeof window.__bootApp === 'function';
        if (supaReady && appReady) { start(); return; }
        if (++_waited > 200) { start(); return; }   // ~20s safety net — start anyway (will surface an error)
        setTimeout(go, 100);
    })();
})();
