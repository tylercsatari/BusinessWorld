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

function isPrimaryOwnerAccount(account) {
    return !!(
        account
        && account.role === 'owner'
        && String(account.email || '').trim().toLowerCase()
            === OWNER_EMAIL
    );
}

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

// ── Permissions: resolve an account to what it can see/do ──
// role is 'owner' | 'pending' | <profileId>. Profiles (R2 `profiles`) define
// { buildings:[], hud:{}, features:{} }. owner = everything; pending = nothing.
async function permsForAccount(account) {
    if (!account) return { none: true, role: null };
    if (account.role === 'owner') return { all: true, role: 'owner' };
    if (account.role === 'pending' || !account.role) return { none: true, role: 'pending' };
    const profiles = await dataStore.getAll('profiles');
    const p = profiles.find(x => x.id === account.role);
    if (!p) return { none: true, role: 'pending', profileMissing: true };
    return {
        role: account.role, profileId: p.id, profileName: p.name,
        buildings: Array.isArray(p.buildings) ? p.buildings : [],
        hud: p.hud || {}, features: p.features || {}
    };
}

// The standalone Experiment Lab renders the canonical Shorts Experiment surface.
// Keep its shared authorization boundary explicit: nearby Raw / Hooks research
// routes must continue to fall through to the owner-only default.
const SHORTS_EXPERIMENT_SHARED_ROUTES = [
    /^\/api\/indicators\/registry$/,
    /^\/api\/shortsquant\/jobs\/j[a-z0-9]+$/,
    /^\/api\/raw\/(?:scorer-contract|plot|map|embed-youtube|embed-upload|embed-montage|hook-save|hook-enrich|hook-delete|folder-create|folder-delete|hook-move|saved-hooks)$/,
    /^\/api\/raw\/saved-(?:hook|montage)\/[a-z0-9]{1,32}$/,
    /^\/api\/raw\/saved-channels$/,
    /^\/api\/raw\/saved-channel$/,
    /^\/api\/raw\/saved-channel\/ch[a-f0-9]{16}(?:\/(?:analysis|stop|resume|delete))?$/,
    /^\/api\/raw\/saved-channel\/ch[a-f0-9]{16}\/(?:video|montage)\/[\w-]{11}$/,
    /^\/api\/storyboards$/,
    /^\/api\/storyboards\/(?:generate|panel|montage|save)$/,
    /^\/api\/storyboards\/sb[a-z0-9]{10,40}$/,
    /^\/api\/storyboards\/media\/[a-f0-9]{64}\.(?:jpg|png|webp)$/,
    /^\/api\/frames\/(?:plan|gen)$/,
    /^\/api\/hooks\/(?:generate|warmup|grind)$/,
    /^\/api\/hooks\/demo\/status\/[\w-]{1,40}$/,
    /^\/api\/hooks\/grpo\/group\/demo\/[\w-]{1,32}$/,
    /^\/api\/hooks\/grpo\/montage\/demo\/[\w-]{1,40}$/,
    /^\/api\/hooks\/grpo\/score\/demo\/[\w-]{1,40}$/,
    /^\/api\/hooks\/grind\/runs$/,
    /^\/api\/hooks\/grind\/(?:run|stop)\/[a-z0-9]{1,32}$/,
    /^\/api\/hooks\/grind\/(?:score|montage)\/[\w-]{1,48}$/,
];

function isShortsExperimentSharedRoute(pathname) {
    const path = String(pathname || '').split(/[?#]/, 1)[0];
    return SHORTS_EXPERIMENT_SHARED_ROUTES.some(pattern => pattern.test(path));
}

// Which building "owns" an API route (for authorization). A plus-delimited
// value is an OR requirement. 'shared' = any signed-in member; 'owner' = owner
// only (safe default for anything unmapped).
function routeBuilding(pathname) {
    if (/^\/api\/experimentlab(?:\/|$)/.test(pathname)) return 'Experiment Lab';
    if (isShortsExperimentSharedRoute(pathname)) return 'Jarvis+Experiment Lab';
    if (/^\/api\/airtable\//.test(pathname) || /^\/api\/pinecone\//.test(pathname) || /^\/api\/data\/storage(history|boxes|items)/.test(pathname)) return 'Storage';
    if (/^\/api\/data\/inventory/.test(pathname)) return 'Storage+Workshop';
    if (/^\/api\/data\/(videos|components|orders|projects)/.test(pathname)) return 'Workshop';
    if (/^\/api\/dropbox\//.test(pathname) || /^\/api\/workshop\//.test(pathname)) return 'Workshop';
    if (/^\/api\/data\/(ideas|notes|todos|calendar|sponsors|sponsorvideos)/.test(pathname) || /^\/api\/ideas\//.test(pathname)) return 'Library';
    if (/^\/api\/(finance|plaid)\//.test(pathname)) return 'Finance';
    // Invoices are created/viewed from Library → Sponsors, so they're gated with the
    // Library building (and the sponsors section, below) — anyone who can use Sponsors
    // can make & see invoices, instead of needing a separate building grant.
    if (/^\/api\/data\/invoices/.test(pathname) || /^\/api\/invoices\//.test(pathname)) return 'Library';
    if (/^\/api\/(jarvis|tribe|longquant|shortsquant)\//.test(pathname)) return 'Jarvis';
    if (/^\/api\/(gemini|videolab)\//.test(pathname)) return 'Video Lab';
    if (/^\/api\/casino\//.test(pathname)) return 'Casino';
    if (/^\/api\/(openai|kimi)\//.test(pathname)) return 'shared';      // AI used across buildings
    if (pathname === '/load-layout' || pathname === '/api/config' || pathname === '/config.js') return 'shared';
    if (/^\/api\/data\/settings/.test(pathname)) return 'shared';
    return 'owner';
}
// Data routes that map to a single building tab/section, for section-level gating.
function routeSection(pathname) {
    if (/^\/api\/data\/todos/.test(pathname)) return ['Library', 'todo'];
    if (/^\/api\/data\/calendar/.test(pathname)) return ['Library', 'calendar'];
    if (/^\/api\/data\/(sponsors|sponsorvideos)/.test(pathname)) return ['Library', 'sponsors'];
    if (/^\/api\/data\/invoices/.test(pathname) || /^\/api\/invoices\//.test(pathname)) return ['Library', 'sponsors'];
    if (/^\/api\/data\/ideas/.test(pathname) || /^\/api\/ideas\//.test(pathname)) return ['Library', 'notes'];
    if (/^\/api\/data\/notes/.test(pathname)) return ['Library', 'freenotes'];
    // Workshop is the pipeline now (no Orders tab); its data is building-level +
    // per-stage gating is enforced in the UI. No Workshop route-section here.
    return null;
}
// A section is allowed if the building grants no section restrictions (full), else
// only if that specific section feature is set.
function sectionAllow(perms, building, section) {
    const feats = perms.features || {};
    const keys = Object.keys(feats).filter(k => k.indexOf(building + ':') === 0);
    if (!keys.length) return true;
    return !!feats[building + ':' + section];
}
function permsAllow(perms, pathname, method) {
    if (perms.all) return true;
    if (perms.none) return false;
    const b = routeBuilding(pathname);
    if (b === 'shared') return true;
    if (b === 'owner') return false;
    const bs = perms.buildings || [];
    const requiredBuildings = b.split('+').map(name => name.trim()).filter(Boolean);
    const buildingOk = requiredBuildings.some(building => bs.includes(building));
    if (!buildingOk) return false;
    const sec = routeSection(pathname);
    if (sec && bs.includes(sec[0])) return sectionAllow(perms, sec[0], sec[1]);
    return true;
}

// Public paths that never require auth.
function isPublic(pathname, method) {
    if (method === 'OPTIONS') return true;
    if (pathname === '/api/me' || pathname === '/api/auth/config') return true;
    if (pathname === '/api/raw/upload-health') return true; // dependency/diagnostic status strings only — no data, no secrets
    if (pathname.startsWith('/api/v1/')) return true;     // read-only public API (its own key)
    if (pathname.startsWith('/api/raw/montage/')) return true; // hook frame-stitches from public YT videos; no data, lets <img> load without a token
    if (pathname.startsWith('/api/raw-long/montage/')) return true; // long-form thumbnails (public YT thumbs); no data, lets <img> load without a token
    if (pathname.startsWith('/api/longquant/guesses/montage/')) return true; // generated thumbnail guesses (no data), lets <img> load without a token
    if (pathname.startsWith('/api/longquant/ideas/montage/')) return true; // idea-chain thumbnails (no data), lets <img> load without a token
    if (pathname.startsWith('/api/longquant/thumbs/img/')) return true; // saved long-form thumbnails (no data), lets <img> load without a token
    if (pathname.startsWith('/api/longquant/grind/img/')) return true; // grind thumbnails (no data), lets <img> load without a token
    if (pathname.startsWith('/api/longquant/grind/original/')) return true; // source thumbnails scored as grind baselines
    if (pathname === '/api/longquant/grind/status' || pathname === '/api/longquant/grind/runs' || pathname.startsWith('/api/longquant/grind/run/')) return true; // experiment progress/status, no account secrets
    if (pathname === '/api/longquant/grind/stop') return true; // stop flag (write-only, needs the rid)
    if (pathname.startsWith('/api/hooks/montage/')) return true; // historical generated corpus media
    if (pathname.startsWith('/api/raw-long/saved-montage/')) return true; // saved-hook montages via raw-long alias
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
    const scopedExperimentLabRequest =
        String(
            req
            && req.headers
            && req.headers['x-business-world-surface']
            || ''
        ).toLowerCase() === 'experiment-lab';
    if (
        isPublic(pathname, method)
        && !scopedExperimentLabRequest
    ) {
        return { allow: true, account: null };
    }

    const account = await accountForRequest(req, url);
    if (!account) return { allow: false, status: 401, body: { error: 'Sign in required' } };
    const perms = await permsForAccount(account);
    if (perms.none) return { allow: false, status: 403, body: { error: 'pending', message: 'Your account is awaiting access.' } };
    if (!permsAllow(perms, pathname, method)) {
        return { allow: false, status: 403, body: { error: 'forbidden', message: 'Your profile does not have access to this.' } };
    }
    return { allow: true, account, perms };
}

module.exports = {
    SUPABASE_URL, SUPABASE_ANON_KEY, OWNER_EMAIL, ROLES,
    verifyToken, getOrCreateAccount, accountForRequest, gate, permsForAccount,
    routeBuilding, permsAllow, isPublic,
    isShortsExperimentSharedRoute,
    isPrimaryOwnerAccount,
};
