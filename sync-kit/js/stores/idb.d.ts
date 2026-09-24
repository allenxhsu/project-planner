import type { BlobStore, Store, SyncRecord } from '../store.js';
/** The three object stores. Named here so an app doing its own surgery can find them. */
export declare const IDB_STORES: {
    readonly records: 'records';
    readonly meta: 'meta';
    readonly blobs: 'blobs';
};
export interface IndexedDbStoreOptions {
    /**
     * Database name. IndexedDB is keyed by it, so an app that changes this
     * orphans everything its users have written — pick one and keep it.
     */
    name: string;
    /** Schema version. Raise it when you add an index. */
    version?: number;
    /**
     * Extra indexes on the record store, as name → key path. `updatedAt` is
     * always indexed, because `changedSince` is a range scan over it and that is
     * what keeps sync cheap as the database grows.
     */
    indexes?: Record<string, string>;
    /**
     * Runs once, before the database is opened for the first time.
     *
     * The hook exists for migrations that have to happen while the database is
     * still closed — Heptabase copies across a database written under an earlier
     * app name here. Best-effort: a failure must not stop the app from starting.
     */
    beforeOpen?: () => Promise<void>;
}
/** Creates or extends the stores. Shared by a normal open and by any adoption. */
export declare function upgradeDatabase(db: IDBDatabase, tx: IDBTransaction | null, indexes: Record<string, string>): void;
/** Opens a database with this schema. Exported for migrations that predate the store. */
export declare function openDatabase(opts: IndexedDbStoreOptions): Promise<IDBDatabase>;
/**
 * Browser-side store.
 *
 * IndexedDB is the only browser storage that is both large enough for a real
 * corpus and transactional. Everything an app has to choose — the database
 * name, its version, the indexes it wants beyond `updatedAt` — arrives as
 * options, so two apps sharing this file do not share a database.
 */
export declare class IndexedDbStore<R extends SyncRecord = SyncRecord> implements Store<R>, BlobStore {
    private readonly opts;
    readonly name = "indexeddb";
    private db;
    constructor(opts: IndexedDbStoreOptions);
    open(): Promise<void>;
    private handle;
    close(): Promise<void>;
    all(): Promise<R[]>;
    get(id: string): Promise<R | null>;
    put(records: R[]): Promise<void>;
    changedSince(ts: number): Promise<R[]>;
    meta<T>(key: string): Promise<T | null>;
    setMeta<T>(key: string, value: T): Promise<void>;
    clear(): Promise<void>;
    putBlob(id: string, data: Blob): Promise<void>;
    getBlob(id: string): Promise<Blob | null>;
    hasBlob(id: string): Promise<boolean>;
}
