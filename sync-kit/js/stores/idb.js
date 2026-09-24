/** The three object stores. Named here so an app doing its own surgery can find them. */
export const IDB_STORES = {
    records: 'records',
    meta: 'meta',
    blobs: 'blobs',
};
/** Promise wrapper for an IDBRequest. */
function req(r) {
    return new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}
/** Resolves when the transaction commits, so callers can await durability. */
function done(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}
/** Creates or extends the stores. Shared by a normal open and by any adoption. */
export function upgradeDatabase(db, tx, indexes) {
    let records;
    if (db.objectStoreNames.contains(IDB_STORES.records)) {
        // An existing database in the middle of a version change: the indexes have
        // to be added to the store the upgrade transaction already owns.
        if (!tx)
            return;
        records = tx.objectStore(IDB_STORES.records);
    }
    else {
        records = db.createObjectStore(IDB_STORES.records, { keyPath: 'id' });
    }
    for (const [name, keyPath] of Object.entries({ updatedAt: 'updatedAt', ...indexes })) {
        if (!records.indexNames.contains(name))
            records.createIndex(name, keyPath);
    }
    if (!db.objectStoreNames.contains(IDB_STORES.meta))
        db.createObjectStore(IDB_STORES.meta);
    // IndexedDB stores Blobs natively, so image bytes are held as-is rather than
    // base64-inflated by a third.
    if (!db.objectStoreNames.contains(IDB_STORES.blobs))
        db.createObjectStore(IDB_STORES.blobs);
}
/** Opens a database with this schema. Exported for migrations that predate the store. */
export function openDatabase(opts) {
    const open = opts.version === undefined ? indexedDB.open(opts.name) : indexedDB.open(opts.name, opts.version);
    open.onupgradeneeded = () => upgradeDatabase(open.result, open.transaction, opts.indexes ?? {});
    return req(open);
}
/**
 * Browser-side store.
 *
 * IndexedDB is the only browser storage that is both large enough for a real
 * corpus and transactional. Everything an app has to choose — the database
 * name, its version, the indexes it wants beyond `updatedAt` — arrives as
 * options, so two apps sharing this file do not share a database.
 */
export class IndexedDbStore {
    opts;
    name = 'indexeddb';
    db = null;
    constructor(opts) {
        this.opts = opts;
    }
    async open() {
        if (this.db)
            return;
        if (this.opts.beforeOpen) {
            try {
                await this.opts.beforeOpen();
            }
            catch {
                // A migration is a convenience, not a correctness requirement.
            }
        }
        this.db = await openDatabase(this.opts);
    }
    handle() {
        if (!this.db)
            throw new Error('IndexedDbStore used before open()');
        return this.db;
    }
    async close() {
        this.db?.close();
        this.db = null;
    }
    async all() {
        const tx = this.handle().transaction(IDB_STORES.records, 'readonly');
        return req(tx.objectStore(IDB_STORES.records).getAll());
    }
    async get(id) {
        const tx = this.handle().transaction(IDB_STORES.records, 'readonly');
        const found = await req(tx.objectStore(IDB_STORES.records).get(id));
        return found ?? null;
    }
    async put(records) {
        if (records.length === 0)
            return;
        const tx = this.handle().transaction(IDB_STORES.records, 'readwrite');
        const os = tx.objectStore(IDB_STORES.records);
        for (const r of records)
            os.put(r);
        await done(tx);
    }
    async changedSince(ts) {
        const tx = this.handle().transaction(IDB_STORES.records, 'readonly');
        const idx = tx.objectStore(IDB_STORES.records).index('updatedAt');
        const range = IDBKeyRange.lowerBound(ts, true);
        return req(idx.getAll(range));
    }
    async meta(key) {
        const tx = this.handle().transaction(IDB_STORES.meta, 'readonly');
        const found = await req(tx.objectStore(IDB_STORES.meta).get(key));
        return found ?? null;
    }
    async setMeta(key, value) {
        const tx = this.handle().transaction(IDB_STORES.meta, 'readwrite');
        tx.objectStore(IDB_STORES.meta).put(value, key);
        await done(tx);
    }
    async clear() {
        const names = [IDB_STORES.records, IDB_STORES.meta, IDB_STORES.blobs];
        const tx = this.handle().transaction(names, 'readwrite');
        for (const name of names)
            tx.objectStore(name).clear();
        await done(tx);
    }
    async putBlob(id, data) {
        const tx = this.handle().transaction(IDB_STORES.blobs, 'readwrite');
        tx.objectStore(IDB_STORES.blobs).put(data, id);
        await done(tx);
    }
    async getBlob(id) {
        const tx = this.handle().transaction(IDB_STORES.blobs, 'readonly');
        const found = await req(tx.objectStore(IDB_STORES.blobs).get(id));
        return found ?? null;
    }
    async hasBlob(id) {
        const tx = this.handle().transaction(IDB_STORES.blobs, 'readonly');
        const key = await req(tx.objectStore(IDB_STORES.blobs).getKey(id));
        return key !== undefined;
    }
}
