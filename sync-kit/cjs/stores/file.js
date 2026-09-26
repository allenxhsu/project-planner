"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileStore = void 0;
// Held in variables so that neither a bundler nor TypeScript tries to
// resolve them: the client compiles with no Node types, and a page that
// imports the kit must not be asked to find `node:sqlite`.
const NODE_SQLITE = 'node:sqlite';
const NODE_FS = 'node:fs';
const NODE_PATH = 'node:path';
class FileStore {
    opts;
    name = 'file';
    db = null;
    statements = {};
    constructor(opts) {
        this.opts = opts;
    }
    async open() {
        if (this.db)
            return;
        const [sqlite, fs, path] = await Promise.all([
            Promise.resolve(`${NODE_SQLITE}`).then(s => __importStar(require(s))),
            Promise.resolve(`${NODE_FS}`).then(s => __importStar(require(s))),
            Promise.resolve(`${NODE_PATH}`).then(s => __importStar(require(s))),
        ]);
        fs.mkdirSync(path.dirname(this.opts.path), { recursive: true });
        const db = new sqlite.DatabaseSync(this.opts.path);
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = FULL');
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        id         TEXT PRIMARY KEY,
        updated_at REAL NOT NULL,
        body       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_by_updated ON records (updated_at);
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blobs (
        id   TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        data BLOB NOT NULL
      );
    `);
        this.statements = {
            all: db.prepare('SELECT body FROM records ORDER BY updated_at, id'),
            get: db.prepare('SELECT body FROM records WHERE id = ?'),
            put: db.prepare(`
        INSERT INTO records (id, updated_at, body) VALUES (?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, body = excluded.body
      `),
            changed: db.prepare('SELECT body FROM records WHERE updated_at > ? ORDER BY updated_at, id'),
            metaGet: db.prepare('SELECT value FROM meta WHERE key = ?'),
            metaSet: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
            blobGet: db.prepare('SELECT mime, data FROM blobs WHERE id = ?'),
            blobHas: db.prepare('SELECT 1 AS present FROM blobs WHERE id = ?'),
            blobPut: db.prepare('INSERT INTO blobs (id, mime, data) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET mime = excluded.mime, data = excluded.data'),
        };
        this.db = db;
    }
    handle() {
        if (!this.db)
            throw new Error('FileStore used before open()');
        return this.db;
    }
    stmt(name) {
        this.handle();
        return this.statements[name];
    }
    async close() {
        this.db?.close();
        this.db = null;
        this.statements = {};
    }
    async all() {
        return this.stmt('all')
            .all()
            .map((row) => JSON.parse(row.body));
    }
    async get(id) {
        const row = this.stmt('get').get(id);
        return row ? JSON.parse(row.body) : null;
    }
    async put(records) {
        if (records.length === 0)
            return;
        const db = this.handle();
        // One transaction, so a batch of pulled records is all there or all not:
        // half a sync on disk after a crash would be a store that disagrees with
        // the cursor it banked.
        db.exec('BEGIN IMMEDIATE');
        try {
            for (const record of records)
                this.stmt('put').run(record.id, record.updatedAt, JSON.stringify(record));
            db.exec('COMMIT');
        }
        catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
    }
    async changedSince(ts) {
        return this.stmt('changed')
            .all(ts)
            .map((row) => JSON.parse(row.body));
    }
    async meta(key) {
        const row = this.stmt('metaGet').get(key);
        return row ? JSON.parse(row.value) : null;
    }
    async setMeta(key, value) {
        this.stmt('metaSet').run(key, JSON.stringify(value ?? null));
    }
    async clear() {
        this.handle().exec('DELETE FROM records; DELETE FROM meta; DELETE FROM blobs;');
    }
    async putBlob(id, data) {
        const bytes = new Uint8Array(await data.arrayBuffer());
        this.stmt('blobPut').run(id, data.type || 'application/octet-stream', bytes);
    }
    async getBlob(id) {
        const row = this.stmt('blobGet').get(id);
        if (!row)
            return null;
        return new Blob([row.data], { type: row.mime });
    }
    async hasBlob(id) {
        return this.stmt('blobHas').get(id) !== undefined;
    }
}
exports.FileStore = FileStore;
