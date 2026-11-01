/**
 * Hearing about a change the moment the server accepts it.
 *
 * Pull-and-push is complete on its own; this only decides *when* to run it.
 * A page that syncs every thirty seconds is thirty seconds behind whoever
 * else just wrote — a phone, a Mac, an agent — and for some apps that is the
 * difference between "live" and "refresh to see". `GET /sync/events` is a
 * server-sent event stream that says `change` with the new head whenever a
 * push to the workspace was accepted, and the client's whole response is to
 * sync as it always did.
 *
 * Over `fetch`, not `EventSource`: `EventSource` cannot carry an
 * `Authorization` header, and a token in the URL is exactly what the server
 * refuses (see the protocol's note on asset tokens). Streamed `fetch` works
 * everywhere this kit runs — a page, a WKWebView, Node — and sends the Portal
 * cookie by the same `credentials` rule as the transport.
 */
export interface ChangeEvent {
    /** The workspace's head after the write: what a caught-up pull would hold. */
    cursor: number;
}
export interface WatchOptions {
    /** The workspace URL, e.g. `https://host/w/idef0`; the route is appended. */
    baseUrl: string;
    /** Bearer token. Unused on the Portal, where the cookie is the credential. */
    token?: string;
    onChange: (change: ChangeEvent) => void;
    /**
     * A failure to connect or a dropped stream. Informational: the watch
     * reconnects by itself, backing off from `retryMs` to thirty seconds.
     * `SyncUnauthorized` is the one exception — after it the watch stops,
     * because a refused credential does not improve with retrying.
     */
    onError?: (err: Error) => void;
    /** Injected by tests; the global otherwise. */
    fetch?: typeof fetch;
    /** The first reconnect pause, in milliseconds. Doubles up to thirty seconds. */
    retryMs?: number;
}
export interface WatchHandle {
    stop(): void;
    /** False once stopped, or once the credential was refused. */
    readonly active: boolean;
}
export declare function watchChanges(opts: WatchOptions): WatchHandle;
