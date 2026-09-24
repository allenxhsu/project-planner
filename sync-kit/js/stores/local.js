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
export class LocalStore {
    name = 'localstorage';
    storage;
    recordsKey;
    metaKey;
    constructor(opts) {
        this.storage = opts.storage ?? globalThis.localStorage;
        this.recordsKey = `${opts.prefix}.records`;
        this.metaKey = `${opts.prefix}.meta`;
    }
    async open() { }
    async close() { }
    read(key) {
        const raw = this.storage.getItem(key);
        if (!raw)
            return {};
        try {
            const parsed = JSON.parse(raw);
            // Corrupt storage is not worth crashing an app over; sync refills it.
            return parsed && typeof parsed === 'object' ? parsed : {};
        }
        catch {
            return {};
        }
    }
    write(key, value) {
        this.storage.setItem(key, JSON.stringify(value));
    }
    async all() {
        return Object.values(this.read(this.recordsKey));
    }
    async get(id) {
        return this.read(this.recordsKey)[id] ?? null;
    }
    async put(records) {
        if (records.length === 0)
            return;
        const held = this.read(this.recordsKey);
        for (const record of records)
            held[record.id] = record;
        this.write(this.recordsKey, held);
    }
    async changedSince(ts) {
        return (await this.all()).filter((r) => r.updatedAt > ts);
    }
    async meta(key) {
        const held = this.read(this.metaKey);
        return key in held ? held[key] : null;
    }
    async setMeta(key, value) {
        const held = this.read(this.metaKey);
        held[key] = value;
        this.write(this.metaKey, held);
    }
    async clear() {
        this.storage.removeItem(this.recordsKey);
        this.storage.removeItem(this.metaKey);
    }
}
