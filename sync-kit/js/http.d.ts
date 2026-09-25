import type { SyncRecord } from './store.js';
import type { PullRequest, PullResponse, PushRequest, PushResponse, Transport } from './protocol.js';
export interface HttpTransportOptions {
    /** The workspace URL, e.g. `https://host/w/idef0`. The routes are appended. */
    baseUrl: string;
    /** Bearer token. Unused by a desktop loopback server, required by a cloud one. */
    token?: string;
    /** What to call this remote in the UI. Defaults to the workspace, or the host. */
    label?: string;
    /**
     * Called when the server refuses the credential — a 401, and only a 401.
     *
     * The Portal is why this exists. A session cookie expires, or is revoked
     * while a tab is open, and every sync from then on fails with a message
     * about a status code that means nothing to the person reading it. The app
     * that owns the UI is the only thing that knows what to do about it — offer
     * Sign in, go back to the Portal, say something useful — so the transport
     * reports it and stays out of the decision.
     */
    onUnauthorized?: () => void;
}
/**
 * A refusal that means "your credential, not your request".
 *
 * Distinguished from every other failure because it is the only one a person
 * can act on: a 500 is ours, a timeout is the network, and a 401 is a sign-in
 * that has run out. `code` is what the UI switches on, so it does not have to
 * match on a message that was never meant to be parsed.
 */
export declare class SyncUnauthorized extends Error {
    readonly code = "unauthorized";
    constructor(route: string);
}
/**
 * HTTP transport.
 *
 * This is the whole "online sync" story: point `baseUrl` at the desktop app's
 * loopback server to sync a browser tab with the desktop database, or at a
 * hosted server to sync across machines. Nothing else in the app changes.
 */
export declare class HttpTransport<R extends SyncRecord = SyncRecord> implements Transport<R> {
    private readonly opts;
    readonly label: string;
    constructor(opts: HttpTransportOptions);
    private call;
    pull(req: PullRequest): Promise<PullResponse<R>>;
    push(req: PushRequest<R>): Promise<PushResponse>;
}
