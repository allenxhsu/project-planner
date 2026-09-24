import type { BlobStore, Store, SyncRecord } from '../store.js';
/**
 * Everything in a Map.
 *
 * A stand-in for IndexedDB and for the desktop's JSON file, faithful in the
 * only ways the engine cares about: `changedSince` is exclusive, and `put` is
 * an upsert that does not re-stamp anything. Tests use it; so does an app that
 * wants a scratch workspace that disappears on reload.
 */
export declare class MemoryStore<R extends SyncRecord = SyncRecord> implements Store<R>, BlobStore {
    readonly name: string;
    private readonly records;
    private readonly metadata;
    private readonly blobs;
    constructor(name?: string);
    open(): Promise<void>;
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
