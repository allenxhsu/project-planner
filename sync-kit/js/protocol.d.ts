import type { SyncRecord } from './store.js';
/**
 * The wire protocol.
 *
 * Deliberately tiny and stateless: a client says "give me everything newer
 * than cursor C" and "here are my changes". Because every record already
 * carries its own timestamp, tombstone and origin, the server needs no
 * schema knowledge beyond storing rows by id — which is why the same endpoint
 * can be an Electron process on loopback and a hosted service in the same
 * afternoon, and why one deployment serves every app in the suite.
 */
export interface PullRequest {
    since: number;
    deviceId: string;
}
export interface PullResponse<R extends SyncRecord = SyncRecord> {
    records: R[];
    /** Feed back as `since` on the next pull. */
    cursor: number;
}
export interface PushRequest<R extends SyncRecord = SyncRecord> {
    records: R[];
    deviceId: string;
}
export interface PushResponse {
    accepted: number;
    /** Server clock at the time of the write, so clients can advance safely. */
    cursor: number;
}
/** Anything that can move records between two stores. */
export interface Transport<R extends SyncRecord = SyncRecord> {
    readonly label: string;
    pull(req: PullRequest): Promise<PullResponse<R>>;
    push(req: PushRequest<R>): Promise<PushResponse>;
}
export declare const SYNC_ROUTES: {
    readonly pull: '/sync/pull';
    readonly push: '/sync/push';
    readonly health: '/sync/health';
};
