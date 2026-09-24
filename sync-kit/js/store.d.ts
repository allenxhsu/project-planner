/**
 * What sync-kit needs to know about your records, and where it keeps them.
 *
 * Four fields are the whole contract. Everything else on a record is yours,
 * travels untouched and is never looked at — which is why one server and one
 * client can carry Heptabase's cards, IDEF0's activities and Pyramid's
 * arguments without knowing what any of them are.
 */
export interface SyncRecord {
    id: string;
    /** Milliseconds since the epoch, from the device that wrote it. A logical clock. */
    updatedAt: number;
    /** Tombstone. Non-null means deleted; the row stays so the deletion can travel. */
    deletedAt?: number | null;
    /** Device that last wrote this record. Breaks `updatedAt` ties. */
    origin?: string;
}
/**
 * The single persistence seam.
 *
 * Everything above this interface is unaware of whether it is talking to
 * IndexedDB in a browser tab, `localStorage` in a one-page app, a JSON file in
 * an Electron main process, or a Map in a test. Adding a new place to keep
 * records means adding an implementation here, not touching the engine.
 */
export interface Store<R extends SyncRecord = SyncRecord> {
    readonly name: string;
    open(): Promise<void>;
    close(): Promise<void>;
    /** Every record including tombstones. Callers filter the deleted ones out. */
    all(): Promise<R[]>;
    get(id: string): Promise<R | null>;
    /**
     * Upsert. Records arrive with `updatedAt` already stamped by the caller so
     * that local edits and merged remote writes travel the same path.
     */
    put(records: R[]): Promise<void>;
    /**
     * Records touched strictly after `ts` — the outgoing half of a sync.
     *
     * Exclusive on purpose: the push cursor is the highest `updatedAt` already
     * sent, so including it would re-send that record on every idle pass.
     */
    changedSince(ts: number): Promise<R[]>;
    /** Small key/value space for the sync cursors and app preferences. */
    meta<T>(key: string): Promise<T | null>;
    setMeta<T>(key: string, value: T): Promise<void>;
    /** Wipe everything. Used by import-replace and by tests. */
    clear(): Promise<void>;
}
/**
 * Binary blobs, keyed by asset id.
 *
 * Kept apart from `Store` because it is the one capability a backing store can
 * reasonably lack — `localStorage` cannot hold bytes — and because image bytes
 * never change once written, so replicating them through the same
 * last-write-wins path as text edits would be pure waste. A store that has
 * both implements `Store<R> & BlobStore`.
 */
export interface BlobStore {
    putBlob(id: string, data: Blob): Promise<void>;
    getBlob(id: string): Promise<Blob | null>;
    hasBlob(id: string): Promise<boolean>;
}
/**
 * Last-write-wins merge for one record.
 *
 * Ordering: newer `updatedAt` wins; identical timestamps are broken by
 * comparing `origin` device ids, which is arbitrary but *consistent* — every
 * device, and the server, independently reach the same answer, which is what
 * makes the outcome independent of the order things arrived in.
 */
export declare function mergeRecord<R extends SyncRecord>(local: R | undefined, remote: R): R;
