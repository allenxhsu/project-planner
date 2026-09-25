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
export interface PortalSession {
    email: string;
    /** App id to workspace, for the apps this session reaches. */
    workspaces: Record<string, string>;
    /** The Portal's roster, as it was built. */
    apps: readonly PortalApp[];
}
export interface PortalApp {
    id: string;
    workspace: string;
    [field: string]: unknown;
}
export interface PortalRemote {
    /** Ready for `new HttpTransport({ baseUrl })`. Same-origin, so no token. */
    baseUrl: string;
    workspace: string;
}
/**
 * Which app this page is, or null when it is not being served by a Portal.
 *
 * Read from a `<meta name="toolkit-portal" content="<id>">` the Portal injects
 * into each app's `index.html` at build time. A meta tag rather than the first
 * path segment because an app may route on paths of its own, and rather than
 * a global because a build that forgets it should be null instead of whatever
 * the last script happened to set.
 */
export declare function portalApp(): string | null;
export interface PortalSessionOptions {
    /** Injected by tests. Defaults to the global `fetch`. */
    fetch?: typeof globalThis.fetch;
    /** Where the cached answer lives. Defaults to `localStorage`. */
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
    /** The origin to ask. Defaults to the page's own. */
    origin?: string;
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
export declare function portalSession(options?: PortalSessionOptions): Promise<PortalSession | null>;
/**
 * Where an app on the Portal should sync, or null.
 *
 * No token, deliberately: the browser already holds a session cookie for this
 * origin, `HttpTransport` sends `credentials: 'same-origin'`, and a token in
 * the page would be a second credential to leak for no benefit.
 */
export declare function portalRemote(appId: string, session: PortalSession | null): PortalRemote | null;
/** The path to send somebody to when their session has run out. */
export declare function portalSignInPath(next?: string): string;
