/**
 * instagram-service.js — post Instagram TRIAL REELS via the official Instagram
 * Graph API (Instagram Login flow). Trial reels are reels shown only to
 * NON-followers first, so you can split-test a short before it hits your audience.
 *
 * Flow (Meta docs):
 *   1. OAuth (Instagram Login) → short-lived token → long-lived token (~60d) + IG user id
 *   2. POST /<ig-user-id>/media   media_type=REELS, video_url=<public url>,
 *                                 trial_params={graduation_strategy:"MANUAL"}   → container id
 *   3. GET  /<container-id>?fields=status_code   poll until FINISHED
 *   4. POST /<ig-user-id>/media_publish   creation_id=<container id>            → media id
 *
 * Requirements (the owner sets these up once):
 *   - A Meta app with INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET (.env + Render env)
 *   - The app's "Instagram API with Instagram Login" product, with the redirect
 *     URI <APP_URL>/api/instagram/callback whitelisted
 *   - A Professional (Business/Creator) Instagram account to connect
 *   - The scope instagram_business_content_publish (App Review for production)
 *
 * Token is stored in the R2 'settings' collection under key 'instagram'.
 */
const dataStore = require('./data-store');

const GRAPH = 'https://graph.instagram.com';
const API_VERSION = process.env.INSTAGRAM_API_VERSION || 'v21.0';
const SCOPES = 'instagram_business_basic,instagram_business_content_publish';

const SETTINGS_KEY = 'instagram';

async function readConn() {
    try {
        const all = await dataStore.getAll('settings');
        return all.find(r => r.key === SETTINGS_KEY) || null;
    } catch (e) { return null; }
}
async function writeConn(fields) {
    const rec = await readConn();
    if (rec) return dataStore.update('settings', rec.id, fields);
    return dataStore.create('settings', { key: SETTINGS_KEY, ...fields });
}

function appCreds() {
    const id = process.env.INSTAGRAM_APP_ID, secret = process.env.INSTAGRAM_APP_SECRET;
    if (!id || !secret) throw new Error('INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET are not set in .env — create a Meta app with "Instagram API with Instagram Login" and add them.');
    return { id, secret };
}

function redirectUri() {
    const base = (process.env.APP_URL || 'http://localhost:8002').replace(/\/$/, '');
    return `${base}/api/instagram/callback`;
}

// Step 1a — the URL the owner visits to authorize.
function authUrl(state) {
    const { id } = appCreds();
    const p = new URLSearchParams({
        client_id: id,
        redirect_uri: redirectUri(),
        response_type: 'code',
        scope: SCOPES,
        ...(state ? { state } : {})
    });
    return `https://www.instagram.com/oauth/authorize?${p.toString()}`;
}

// Step 1b — exchange the OAuth code for a long-lived token + the IG account.
async function exchangeCode(code) {
    const { id, secret } = appCreds();
    // code → short-lived token (+ user_id)
    const form = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'authorization_code', redirect_uri: redirectUri(), code });
    const shortRes = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    const shortText = await shortRes.text();
    if (!shortRes.ok) throw new Error(`Instagram token exchange failed: ${shortRes.status} ${shortText.slice(0, 300)}`);
    const short = JSON.parse(shortText);
    const igUserId = String(short.user_id || (Array.isArray(short.data) && short.data[0] && short.data[0].user_id) || '');
    const shortToken = short.access_token;
    if (!shortToken) throw new Error('Instagram did not return an access token.');
    // short-lived → long-lived (~60 days)
    const longRes = await fetch(`${GRAPH}/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(secret)}&access_token=${encodeURIComponent(shortToken)}`);
    const long = await longRes.json().catch(() => ({}));
    const accessToken = long.access_token || shortToken;
    const expiresAt = long.expires_in ? Date.now() + long.expires_in * 1000 : (Date.now() + 60 * 24 * 3600 * 1000);
    // who is this account?
    let username = '', accountId = igUserId;
    try {
        const meRes = await fetch(`${GRAPH}/me?fields=user_id,username&access_token=${encodeURIComponent(accessToken)}`);
        const me = await meRes.json();
        if (me && me.username) username = me.username;
        if (me && me.user_id) accountId = String(me.user_id);
    } catch (e) {}
    await writeConn({ igUserId: accountId, username, accessToken, expiresAt, connectedAt: new Date().toISOString() });
    return { igUserId: accountId, username };
}

async function status() {
    const c = await readConn();
    if (!c || !c.accessToken || !c.igUserId) return { connected: false, configured: !!(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET) };
    const expired = c.expiresAt && c.expiresAt < Date.now();
    return { connected: !expired, configured: true, username: c.username || '', igUserId: c.igUserId, expiresAt: c.expiresAt, expired };
}

async function disconnect() {
    const rec = await readConn();
    if (rec) await dataStore.remove('settings', rec.id);
    return { connected: false };
}

// Refresh a long-lived token if it's within ~7 days of expiry (best-effort).
async function maybeRefresh(c) {
    if (!c || !c.accessToken) return c;
    if (c.expiresAt && c.expiresAt - Date.now() > 7 * 24 * 3600 * 1000) return c;
    try {
        const r = await fetch(`${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(c.accessToken)}`);
        const d = await r.json();
        if (d && d.access_token) {
            const expiresAt = d.expires_in ? Date.now() + d.expires_in * 1000 : c.expiresAt;
            await writeConn({ accessToken: d.access_token, expiresAt });
            return { ...c, accessToken: d.access_token, expiresAt };
        }
    } catch (e) {}
    return c;
}

/**
 * Publish a Trial Reel from a PUBLIC video URL.
 * @param {object} o { videoUrl, caption, graduation, onStatus }
 *   graduation: 'MANUAL' (you graduate it in-app) | 'SS_PERFORMANCE' (auto if it performs)
 *   onStatus(msg): optional progress callback
 * @returns {Promise<{mediaId:string, permalink?:string}>}
 */
async function postTrialReel({ videoUrl, caption = '', graduation = 'MANUAL', onStatus } = {}) {
    if (!videoUrl) throw new Error('No video URL to post.');
    let c = await readConn();
    if (!c || !c.accessToken || !c.igUserId) throw new Error('Instagram is not connected. Connect an account first.');
    c = await maybeRefresh(c);
    const tok = c.accessToken, ig = c.igUserId;
    const emit = (m) => { try { onStatus && onStatus(m); } catch (e) {} };

    // 2) Create the trial-reel container.
    emit('Creating the trial-reel container…');
    const createBody = new URLSearchParams({
        media_type: 'REELS',
        video_url: videoUrl,
        caption: caption || '',
        trial_params: JSON.stringify({ graduation_strategy: graduation === 'SS_PERFORMANCE' ? 'SS_PERFORMANCE' : 'MANUAL' }),
        access_token: tok
    });
    const createRes = await fetch(`${GRAPH}/${API_VERSION}/${ig}/media`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: createBody.toString() });
    const createData = await createRes.json().catch(() => ({}));
    if (!createRes.ok || !createData.id) throw new Error(`Container create failed: ${createRes.status} ${JSON.stringify(createData).slice(0, 300)}`);
    const containerId = createData.id;

    // 3) Poll until the upload/processing is FINISHED (reels can take a bit).
    emit('Instagram is processing the video…');
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 4000));
        const sRes = await fetch(`${GRAPH}/${API_VERSION}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(tok)}`);
        const s = await sRes.json().catch(() => ({}));
        if (s.status_code === 'FINISHED') break;
        if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Instagram processing ${s.status_code}: ${s.status || ''}`);
        emit(`Processing… (${s.status_code || 'IN_PROGRESS'})`);
    }

    // 4) Publish.
    emit('Publishing the trial reel…');
    const pubBody = new URLSearchParams({ creation_id: containerId, access_token: tok });
    const pubRes = await fetch(`${GRAPH}/${API_VERSION}/${ig}/media_publish`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: pubBody.toString() });
    const pub = await pubRes.json().catch(() => ({}));
    if (!pubRes.ok || !pub.id) throw new Error(`Publish failed: ${pubRes.status} ${JSON.stringify(pub).slice(0, 300)}`);

    // Best-effort permalink.
    let permalink = '';
    try { const lr = await fetch(`${GRAPH}/${API_VERSION}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(tok)}`); const l = await lr.json(); permalink = l.permalink || ''; } catch (e) {}
    emit('Trial reel published ✓');
    return { mediaId: pub.id, permalink };
}

module.exports = { authUrl, exchangeCode, status, disconnect, postTrialReel, readConn };
