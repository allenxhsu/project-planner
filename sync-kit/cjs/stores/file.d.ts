import type { BlobStore, Store, SyncRecord } from '../store.js';
/**
 * A file, for the clients that are not browsers.
 *
 * An Electron main process, the CLI and a test on a laptop all need a store
 * that survives the process, and until now each of them improvised one: the
 * desktop kept its own JSON file, the CLI had nothing. This is one SQLite
 * file through `node:sqlite`, which ships inside Node from 22.13 on, so there
 * is no native module to build and nothing to install.
 *
 * `synchronous = FULL`, unlike the server's NORMAL. The server can afford to
 * lose its last few milliseconds to a power cut because every device holds a
 * copy; an edit typed a moment ago on this machine has no other copy yet, so
 * every commit here is fsynced. The cost is one disk flush per save, which a
 * person typing cannot notice.
 *
 * The module is loaded when `open()` is called, not when this file is
 * imported, so the same `index.js` that exports it can be loaded by a page —
 * a page just cannot open one.
 */
export interface FileStoreOptions {
    /** Where the file lives. Its directory is created if it does not exist. */
    path: string;
}
export declare class FileStore<R extends SyncRecord = SyncRecord> implements Store<R>, BlobStore {
    private readonly opts;
    readonly name = "file";
    private db;
    private statements;
    constructor(opts: FileStoreOptions);
    open(): Promise<void>;
    private handle;
    private stmt;
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
