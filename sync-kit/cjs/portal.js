"use strict";
/**
 * Running inside the Portal.
 *
 * An app served at `/<id>/` on the Portal's origin needs three things it
 * cannot work out for itself: which app it is, who is signed in, and which
 * workspace to sync. All three come from the origin it is already on — the
 * Portal injects the first into the page, and the server answers the other
 * two at `/auth/me` — so an app configures itself with no URL to paste, no
 * token to copy and nothing stored anywhere but a cache.
 *
 * Nothing here is required. An app built for a URL and a token keeps working
 * exactly as it did; `portalApp()` returns null off the Portal and the rest
 * follows from that.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.portalApp = portalApp;
exports.portalSession = portalSession;
exports.portalRemote = portalRemote;
exports.portalSignInPath = portalSignInPath;
/** Where the Portal caches the last answer, for a UI that has to render offline. */
const SESSION_CACHE_KEY = 'toolkit.session';
/**
 * Which app this page is, or null when it is not being served by a Portal.
 *
 * Read from a `<meta name="toolkit-portal" content="<id>">` the Portal injects
 * into each app's `index.html` at build time. A meta tag rather than the first
 * path segment because an app may route on paths of its own, and rather than
 * a global because a build that forgets it should be null instead of whatever
 * the last script happened to set.
 */
function portalApp() {
    if (typeof document === 'undefined')
        return null;
    const meta = document.querySelector('meta[name="toolkit-portal"]');
    const id = meta?.getAttribute('content')?.trim();
    return id && id.length > 0 ? id : null;
}
/**
 * Who is signed in, from `/auth/me`, with the last answer cached.
 *
 * The cache is what makes an app usable on a train. Everything it needs to
 * render — which apps exist, which workspace this one syncs, whose account it
 * is — is stable for weeks, and a local-first app that refused to open its own
 * offline database because a fetch failed would be a poor kind of local-first.
 * So: ask, and fall back to the last answer.
 *
 * A 401 is different, and is not a network failure. It means the session is
 * genuinely gone, and continuing to render somebody's email from a cache
 * would be a lie — so the cache is cleared and null returned, which is the
 * signal to send them to the Portal's front door.
 */
async function portalSession(options = {}) {
    const doFetch = options.fetch ?? globalThis.fetch;
    const store = options.storage === undefined ? defaultStorage() : options.storage;
    const origin = options.origin ?? (typeof location !== 'undefined' ? location.origin : '');
    try {
        const res = await doFetch(`${origin}/auth/me`, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
        });
        if (res.status === 401) {
            store?.removeItem(SESSION_CACHE_KEY);
            return null;
        }
        if (!res.ok)
            return cached(store);
        const session = (await res.json());
        // Written back only when it parses into the shape callers expect, so a
        // proxy's error page cannot become the cached answer.
        if (typeof session?.email === 'string' && session.workspaces) {
            try {
                store?.setItem(SESSION_CACHE_KEY, JSON.stringify(session));
            }
            catch {
                // A full or disabled storage is not a reason to fail the sign-in.
            }
            return session;
        }
        return cached(store);
    }
    catch {
        // Offline, or a server that is not there. The cache is the whole point.
        return cached(store);
    }
}
/**
 * Where an app on the Portal should sync, or null.
 *
 * No token, deliberately: the browser already holds a session cookie for this
 * origin, `HttpTransport` sends `credentials: 'same-origin'`, and a token in
 * the page would be a second credential to leak for no benefit.
 */
function portalRemote(appId, session) {
    const workspace = session?.workspaces?.[appId];
    if (!workspace)
        return null;
    const origin = typeof location !== 'undefined' ? location.origin : '';
    return { baseUrl: `${origin}/w/${workspace}`, workspace };
}
/** The path to send somebody to when their session has run out. */
function portalSignInPath(next) {
    const where = next ?? (typeof location !== 'undefined' ? location.pathname + location.search : '/');
    return where === '/' ? '/' : `/?next=${encodeURIComponent(where)}`;
}
function cached(store) {
    if (!store)
        return null;
    try {
        const raw = store.getItem(SESSION_CACHE_KEY);
        return raw ? JSON.parse(raw) : null;
    }
    catch {
        return null;
    }
}
function defaultStorage() {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    }
    catch {
        // Reading `localStorage` throws outright in a browser with site data
        // blocked, which is a working configuration and not an error.
        return null;
    }
}
