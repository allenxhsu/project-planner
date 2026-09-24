/**
 * Everything in a Map.
 *
 * A stand-in for IndexedDB and for the desktop's JSON file, faithful in the
 * only ways the engine cares about: `changedSince` is exclusive, and `put` is
 * an upsert that does not re-stamp anything. Tests use it; so does an app that
 * wants a scratch workspace that disappears on reload.
 */
export class MemoryStore {
    name;
    records = new Map();
    metadata = new Map();
    blobs = new Map();
    constructor(name = 'memory') {
        this.name = name;
    }
    async open() { }
    async close() { }
    async all() {
        return [...this.records.values()];
    }
    async get(id) {
        return this.records.get(id) ?? null;
    }
    async put(records) {
        for (const record of records)
            this.records.set(record.id, record);
    }
    async changedSince(ts) {
        return [...this.records.values()].filter((r) => r.updatedAt > ts);
    }
    async meta(key) {
        return this.metadata.has(key) ? this.metadata.get(key) : null;
    }
    async setMeta(key, value) {
        this.metadata.set(key, value);
    }
    async clear() {
        this.records.clear();
        this.metadata.clear();
        this.blobs.clear();
    }
    async putBlob(id, data) {
        this.blobs.set(id, data);
    }
    async getBlob(id) {
        return this.blobs.get(id) ?? null;
    }
    async hasBlob(id) {
        return this.blobs.has(id);
    }
}
