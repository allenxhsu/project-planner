import type { Store, SyncRecord } from './store.js';
import type { Transport } from './protocol.js';
/**
 * Both cursors, for whoever has to clear them.
 *
 * They describe this store's position against *one particular server*: the
 * pull cursor is that server's opaque sequence number, and the push cursor is
 * the high-water mark of what we have sent it. Point the same store at a
 * different server and neither means anything there — which is why changing
 * the sync URL has to reset them. Exported so that reset does not depend on
 * someone spelling these two strings the same way twice.
 */
export declare const SYNC_CURSOR_KEYS: readonly ["sync.cursor.pull", "sync.cursor.push"];
export type SyncPhase = 'idle' | 'syncing' | 'error';
export interface SyncStatus {
    phase: SyncPhase;
    lastSyncAt: number | null;
    lastError: string | null;
    pulled: number;
    pushed: number;
    /** Which remote this is the status of. ui-kit shows it when an app has two. */
    label: string;
}
export interface SyncResult<R extends SyncRecord = SyncRecord> {
    pulled: number;
    pushed: number;
    /** Records that actually changed locally — the UI reloads only when > 0. */
    applied: R[];
}
/**
 * Bidirectional last-write-wins sync.
 *
 * Pull first, then push. Doing it in that order means a record the remote
 * already has a newer version of is resolved before we consider sending ours,
 * so we never push a write we are about to discard.
 *
 * Two cursors are tracked rather than one. The pull cursor is *remote* clock
 * time and the push cursor is *local* clock time; conflating them would drop
 * writes whenever the two machines' clocks disagree.
 */
export declare class SyncEngine<R extends SyncRecord = SyncRecord> {
    private readonly store;
    private readonly transport;
    private readonly deviceId;
    private running;
    private current;
    constructor(store: Store<R>, transport: Transport<R>, deviceId: string);
    get label(): string;
    /** The last thing published on `sync-kit:status`, for a widget mounting late. */
    get status(): SyncStatus;
    /**
     * Syncs whenever anything fires `sync-kit:sync-now` on `window`. Returns the
     * unsubscribe function; outside a browser it wires nothing and returns one
     * that does nothing.
     *
     * Errors are swallowed on purpose: a failed sync is already reported through
     * the status event, and an unhandled rejection from a DOM listener is not.
     */
    listen(): () => void;
    sync(): Promise<SyncResult<R>>;
    private publish;
    private pull;
    private push;
}
