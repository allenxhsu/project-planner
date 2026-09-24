import type { Store, SyncRecord } from '../store.js';
export interface LocalStoreOptions {
    /**
     * Key prefix. Two apps on one origin — which is what a folder of static
     * pages served from `localhost` is — would otherwise read each other's
     * records, so the prefix is required rather than defaulted.
     */
    prefix: string;
    /** Somewhere other than `window.localStorage`; `sessionStorage`, in practice. */
    storage?: Storage;
}
/**
 * `localStorage`, for the apps that are one page and a handful of records.
 *
 * Everything lives under two keys — the record map and the meta map — rather
 * than one key per record, because a sync reads every record anyway and the
 * whole point of this store is that there are few of them. `localStorage` is
 * synchronous, string-only and capped at a few megabytes per origin: an app
 * with a real corpus, or with images, wants `IndexedDbStore` instead. There is
 * no `BlobStore` here for the same reason.
 */
export declare class LocalStore<R extends SyncRecord = SyncRecord> implements Store<R> {
    readonly name = "localstorage";
    private readonly storage;
    private readonly recordsKey;
    private readonly metaKey;
    constructor(opts: LocalStoreOptions);
    open(): Promise<void>;
    close(): Promise<void>;
    private read;
    private write;
    all(): Promise<R[]>;
    get(id: string): Promise<R | null>;
    put(records: R[]): Promise<void>;
    changedSince(ts: number): Promise<R[]>;
    meta<T>(key: string): Promise<T | null>;
    setMeta<T>(key: string, value: T): Promise<void>;
    clear(): Promise<void>;
}
