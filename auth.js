/**
 * auth.js — Supabase-token authentication + role-based access gate.
 *
 * BusinessWorld is no longer public. Every API/data request must carry a valid
 * Supabase access token (the same accounts as the jarv1s app). Identity comes
 * from Supabase; AUTHORIZATION (roles) lives in our own R2 `accounts` store, so
 * no Supabase service-role key is needed — only the public URL + anon key.
 *
 * Roles:
 *   owner   — full control (Tyler). Sees everything, manages accounts.
 *   storage — Storage room only (read/write the boxes/items + its assistant).
 *   pending — brand-new signup, no access yet ("waiting for permissions").
 *
 * The owner email is auto-promoted to `owner` on first sign-in.
 */
const dataStore = require('./data-store');

// Business World's OWN Supabase project (separate from jarv1s) — full control of
// login methods + redirect URLs. URL + anon key are public/safe to ship; the
// service-role key is deliberately NOT used (roles live in our R2 `accounts`).
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://uavmizkocnxqlcztvflz.supabase.co').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhdm1pemtvY254cWxjenR2Zmx6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1MzQ2MTUsImV4cCI6MjA5NzExMDYxNX0.78EgQgG23Yjb9S_IlwaXPzHqGd6c_gyZXhwWRlgiHQE';
const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'tylerdaviscsatari@gmail.com').toLowerCase();

const ROLES = ['owner', 'storage', 'pending'];

// ── Verify a Supabase access token against the Auth API → { id, email, name } ──
const tokenCache = new Map(); // token → { user, exp }
async function verifyToken(token) {
    if (!token) return null;
    const hit = tokenCache.get(token);
    if (hit && hit.exp > Date.now()) return hit.user;
    try {
        const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }
        });
        if (!r.ok) { tokenCache.set(token, { user: null, exp: Date.now() + 10000 }); return null; }
        const u = await r.json();
        if (!u || !u.id) return null;
        const meta = u.user_metadata || {};
        const user = { id: u.id, email: (u.email || '').toLowerCase(), name: meta.full_name || meta.name || '' };
        tokenCache.set(token, { user, exp: Date.now() + 60000 }); // 60s cache
        return user;
    } catch (e) { return null; }
}

// ── Resolve (and lazily create) the account record for a verified user ──
async function getOrCreateAccount(user) {
    const all = await dataStore.getAll('accounts');
    let acct = all.find(a => a.id === user.id) || all.find(a => (a.email || '').toLowerCase() === user.email);
    if (acct) {
        const patch = {};
        if (user.email && acct.email !== user.email) patch.email = user.email;
        if (user.name && !acct.name) patch.name = user.name;
        if (user.email === OWNER_EMAIL && acct.role !== 'owner') patch.role = 'owner';
        if (Object.keys(patch).length) acct = await dataStore.update('accounts', acct.id, patch);
        return acct;
    }
    const role = user.email === OWNER_EMAIL ? 'owner' : 'pending';
    return dataStore.create('accounts', { id: user.id, email: user.email, name: user.name || '', role });
}

// Returns the account for a request's token, or null.
function bearerFrom(req, url) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) return h.slice(7);
    return (url && url.searchParams.get('access_token')) || null;
}
async function accountForRequest(req, url) {
    const token = bearerFrom(req, url);
    const user = await verifyToken(token);
    if (!user) return null;
    return getOrCreateAccount(user);
}

// ── Authorization: which API paths a role may touch ──
const STORAGE_OPENAI = /^\/api\/openai\/(chat|embeddings|transcribe|tts)$/;
function roleAllows(role, pathname, method) {
    if (role === 'owner') return true;
    if (role === 'storage') {
        return /^\/api\/airtable\//.test(pathname)
            || /^\/api\/pinecone\//.test(pathname)
            || pathname === '/api/data/storagehistory' || /^\/api\/data\/storagehistory\/[^/]+$/.test(pathname)
            || (/^\/api\/data\/inventory(\/[^/]+)?$/.test(pathname) && method === 'GET')
            || STORAGE_OPENAI.test(pathname)
            || /^\/api\/kimi\//.test(pathname)
            || pathname === '/load-layout'
            || pathname === '/api/config' || pathname === '/config.js';
    }
    return false; // pending / unknown
}

// Public paths that never require auth.
function isPublic(pathname, method) {
    if (method === 'OPTIONS') return true;
    if (pathname === '/api/me' || pathname === '/api/auth/config') return true;
    if (pathname.startsWith('/api/v1/')) return true;     // read-only public API (its own key)
    if (pathname.startsWith('/share/')) return true;       // public share pages
    if (pathname === '/api/youtube/callback') return true; // external OAuth redirect (no token possible)
    if (!pathname.startsWith('/api/')) {
        // static assets + the page itself are public (they contain no data; the
        // app gates itself with the login screen). EXCEPT the data endpoints below.
        if (pathname === '/save-layout' || pathname === '/load-layout') return false;
        return true;
    }
    return false;
}

// The gate. Returns { allow:true, account } | { allow:false, status, body }.
async function gate(req, url) {
    const pathname = url.pathname;
    const method = req.method;
    if (isPublic(pathname, method)) return { allow: true, account: null };

    const account = await accountForRequest(req, url);
    if (!account) return { allow: false, status: 401, body: { error: 'Sign in required' } };
    if (account.role === 'pending') return { allow: false, status: 403, body: { error: 'pending', message: 'Your account is awaiting approval.' } };
    if (!roleAllows(account.role, pathname, method)) {
        return { allow: false, status: 403, body: { error: 'forbidden', message: 'Your role does not have access to this.' } };
    }
    return { allow: true, account };
}

module.exports = {
    SUPABASE_URL, SUPABASE_ANON_KEY, OWNER_EMAIL, ROLES,
    verifyToken, getOrCreateAccount, accountForRequest, gate
};
