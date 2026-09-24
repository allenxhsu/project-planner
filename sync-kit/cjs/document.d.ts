import type { Store, SyncRecord } from './store.js';
/**
 * One whole document as one record.
 *
 * Several apps in the suite are not databases of small things but editors of
 * one text: a Markdown page, a diagram's JSON, an outline. They all want the
 * same shape, so it is written down once here and the server never learns what
 * `body` means.
 */
export interface DocumentRecord extends SyncRecord {
    id: string;
    type: 'document';
    /** How to read `body`: `markdown`, `json`, whatever the app knows. */
    format: string;
    name: string;
    body: string;
    updatedAt: number;
    deletedAt: number | null;
    origin: string;
}
export interface SyncedDocumentOptions {
    id: string;
    /** This device. Stamped on every save; breaks ties with other devices. */
    origin: string;
    format?: string;
    name?: string;
    /** Overridable so tests need not wait for the clock to move. */
    now?: () => number;
}
/**
 * An editor's half of the protocol: load, edit, save, and what to do when a
 * newer version arrives from somewhere else.
 *
 * The rule that matters is the last one. A pulled version is written to the
 * store by the engine regardless — that is how the record stream works — but
 * *replacing what someone is typing* is never acceptable, so the in-memory
 * buffer is only adopted while it is clean. An unsaved edit that loses the
 * race is not lost: the next `save()` stamps a newer `updatedAt` and wins.
 */
export declare class SyncedDocument {
    private readonly store;
    private readonly opts;
    private current;
    private saved;
    private refused;
    private readonly now;
    constructor(store: Store<DocumentRecord>, opts: SyncedDocumentOptions);
    get record(): DocumentRecord;
    get body(): string;
    get name(): string;
    /** True while the buffer holds edits that have not been written to the store. */
    get dirty(): boolean;
    /** Reads what the store already holds, or keeps the empty document. */
    load(): Promise<DocumentRecord>;
    /** In-memory only. Call `save()` to commit; sync sends what is committed. */
    edit(body: string, name?: string): void;
    /**
     * The timestamp for a write, which is the clock unless the clock is not
     * enough.
     *
     * Two saves inside one millisecond would tie on `updatedAt`, and the tie
     * break is on `origin` — the same device both times, so neither would win.
     * And a version this document refused because the buffer was dirty has to be
     * outranked, or the promise that the unsaved edit is not lost would hold
     * only as long as the two devices' clocks agree, which is exactly when
     * losing work is least forgivable.
     */
    private stamp;
    save(): Promise<DocumentRecord>;
    /** Writes a tombstone. The record stays so the deletion can travel. */
    remove(): Promise<DocumentRecord>;
    /**
     * Offers a version that arrived from elsewhere. Adopted only when the buffer
     * is clean and the incoming record actually wins; returns whether it was.
     */
    accept(remote: DocumentRecord): boolean;
    /**
     * The same thing for a whole `SyncResult.applied` list, so a caller can hand
     * over what a sync returned without filtering it first.
     */
    acceptAll(applied: readonly SyncRecord[]): boolean;
}
