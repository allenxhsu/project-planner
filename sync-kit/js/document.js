import { mergeRecord } from './store.js';
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
export class SyncedDocument {
    store;
    opts;
    current;
    saved;
    refused = 0;
    now;
    constructor(store, opts) {
        this.store = store;
        this.opts = opts;
        this.now = opts.now ?? Date.now;
        this.current = {
            id: opts.id,
            type: 'document',
            format: opts.format ?? 'markdown',
            name: opts.name ?? opts.id,
            body: '',
            updatedAt: 0,
            deletedAt: null,
            origin: opts.origin,
        };
        this.saved = '';
    }
    get record() {
        return this.current;
    }
    get body() {
        return this.current.body;
    }
    get name() {
        return this.current.name;
    }
    /** True while the buffer holds edits that have not been written to the store. */
    get dirty() {
        return this.current.body !== this.saved;
    }
    /** Reads what the store already holds, or keeps the empty document. */
    async load() {
        const held = await this.store.get(this.opts.id);
        if (held) {
            this.current = held;
            this.saved = held.body;
        }
        return this.current;
    }
    /** In-memory only. Call `save()` to commit; sync sends what is committed. */
    edit(body, name) {
        this.current = { ...this.current, body, name: name ?? this.current.name };
    }
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
    stamp() {
        return Math.max(this.now(), this.current.updatedAt + 1, this.refused + 1);
    }
    async save() {
        this.current = { ...this.current, updatedAt: this.stamp(), origin: this.opts.origin };
        await this.store.put([this.current]);
        this.saved = this.current.body;
        return this.current;
    }
    /** Writes a tombstone. The record stays so the deletion can travel. */
    async remove() {
        const at = this.stamp();
        this.current = { ...this.current, deletedAt: at, updatedAt: at, origin: this.opts.origin };
        await this.store.put([this.current]);
        this.saved = this.current.body;
        return this.current;
    }
    /**
     * Offers a version that arrived from elsewhere. Adopted only when the buffer
     * is clean and the incoming record actually wins; returns whether it was.
     */
    accept(remote) {
        if (remote.id !== this.opts.id)
            return false;
        if (this.dirty) {
            // Remember what was turned away, so the save that follows beats it.
            this.refused = Math.max(this.refused, remote.updatedAt);
            return false;
        }
        if (mergeRecord(this.current, remote) !== remote)
            return false;
        if (remote.updatedAt === this.current.updatedAt)
            return false;
        this.current = remote;
        this.saved = remote.body;
        return true;
    }
    /**
     * The same thing for a whole `SyncResult.applied` list, so a caller can hand
     * over what a sync returned without filtering it first.
     */
    acceptAll(applied) {
        let adopted = false;
        for (const record of applied) {
            if (record.id === this.opts.id && this.accept(record))
                adopted = true;
        }
        return adopted;
    }
}
