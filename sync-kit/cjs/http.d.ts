import type { SyncRecord } from './store.js';
import type { PullRequest, PullResponse, PushRequest, PushResponse, Transport } from './protocol.js';
export interface HttpTransportOptions {
    /** The workspace URL, e.g. `https://host/w/idef0`. The routes are appended. */
    baseUrl: string;
    /** Bearer token. Unused by a desktop loopback server, required by a cloud one. */
    token?: string;
    /** What to call this remote in the UI. Defaults to the workspace, or the host. */
    label?: string;
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
