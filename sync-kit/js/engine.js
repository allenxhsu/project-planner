import { mergeRecord } from './store.js';
import { onSyncNow, publishStatus } from './events.js';
import { storageStatus } from './persistence.js';
const CURSOR_PULL = 'sync.cursor.pull';
const CURSOR_PUSH = 'sync.cursor.push';
/**
 * Both cursors, for whoever has to clear them.
 *
 * They describe this store's position against *one particular server*: the
 * pull cursor is that server's opaque sequence number, and the push cursor is
 * the high-water mark of what we have sent it. Point the same store at a
 * different server and neither means anything there — which is why changing
 * the sync URL has to reset them. Exported so that reset does not depend on
 * someone spelling these two strings the same way twice.
 */
export const SYNC_CURSOR_KEYS = [CURSOR_PULL, CURSOR_PUSH];
/**
 * Bidirectional last-write-wins sync.
 *
 * Pull first, then push. Doing it in that order means a record the remote
 * already has a newer version of is resolved before we consider sending ours,
 * so we never push a write we are about to discard.
 *
 * Two cursors are tracked rather than one. The pull cursor is *remote* clock
 * time and the push cursor is *local* clock time; conflating them would drop
 * writes whenever the two machines' clocks disagree.
 */
export class SyncEngine {
    store;
    transport;
    deviceId;
    options;
    running = false;
    current;
    constructor(store, transport, deviceId, options = {}) {
        this.store = store;
        this.transport = transport;
        this.deviceId = deviceId;
        this.options = options;
        if (options.mirror && typeof store.changes !== 'function') {
            throw new Error('SyncEngine mirror mode needs a store that implements changes()');
        }
        // Assembled here rather than in a field initialiser: a field initialiser
        // runs before the constructor body under ES2022 class fields, so the
        // transport would not be there to ask for its label yet.
        this.current = {
            phase: 'idle',
            lastSyncAt: null,
            lastError: null,
            pulled: 0,
            pushed: 0,
            label: transport.label,
        };
    }
    get label() {
        return this.transport.label;
    }
    /** The last thing published on `sync-kit:status`, for a widget mounting late. */
    get status() {
        return this.current;
    }
    /**
     * Syncs whenever anything fires `sync-kit:sync-now` on `window`. Returns the
     * unsubscribe function; outside a browser it wires nothing and returns one
     * that does nothing.
     *
     * Errors are swallowed on purpose: a failed sync is already reported through
     * the status event, and an unhandled rejection from a DOM listener is not.
     */
    listen() {
        return onSyncNow(() => {
            void this.sync().catch(() => { });
        });
    }
    async sync() {
        if (this.running) {
            // Overlapping syncs would double-push the same window of records.
            return { pulled: 0, pushed: 0, applied: [] };
        }
        this.running = true;
        this.publish({ phase: 'syncing' });
        try {
            const applied = await this.pull();
            const pushed = await this.push();
            // Read after the sync rather than before: a first sync is the moment a
            // store goes from empty to worth keeping, and the answer can change.
            const storage = await storageStatus();
            this.publish({
                phase: 'idle',
                lastSyncAt: Date.now(),
                lastError: null,
                pulled: applied.length,
                pushed,
                ...(storage ? { storage } : {}),
            });
            return { pulled: applied.length, pushed, applied };
        }
        catch (err) {
            const code = err.code === 'unauthorized' ? 'unauthorized' : null;
            this.publish({ phase: 'error', lastError: err.message, lastErrorCode: code });
            throw err;
        }
        finally {
            this.running = false;
        }
    }
    publish(change) {
        this.current = { ...this.current, ...change };
        publishStatus(this.current);
    }
    async pull() {
        const since = (await this.store.meta(CURSOR_PULL)) ?? 0;
        const { records, cursor } = await this.transport.pull({ since, deviceId: this.deviceId });
        const applied = [];
        if (records.length > 0) {
            // Resolve each incoming record against what we already hold, and write
            // back only the ones that actually won. Rewriting losers would bump
            // their local timestamps and cause an endless push/pull ping-pong.
            for (const remote of records) {
                const local = (await this.store.get(remote.id)) ?? undefined;
                const winner = mergeRecord(local, remote);
                if (winner === remote && (!local || local.updatedAt !== remote.updatedAt)) {
                    applied.push(remote);
                }
            }
            if (applied.length > 0)
                await this.store.put(applied);
        }
        await this.store.setMeta(CURSOR_PULL, cursor);
        return applied;
    }
    async push() {
        const since = (await this.store.meta(CURSOR_PUSH)) ?? 0;
        // A store that numbers its own writes hands over the cursor to bank; the
        // engine never looks inside it. Banked only after the push succeeded, so
        // a failed push is retried from the same place next time.
        if (this.store.changes) {
            const { records, cursor } = await this.store.changes(since);
            const mine = this.options.mirror ? records : records.filter((r) => r.origin === this.deviceId);
            const accepted = mine.length === 0 ? 0 : (await this.transport.push({ records: mine, deviceId: this.deviceId })).accepted;
            await this.store.setMeta(CURSOR_PUSH, cursor);
            return accepted;
        }
        const outgoing = await this.store.changedSince(since);
        // Records we just merged in from the remote carry a foreign `origin`;
        // sending them straight back is pure noise.
        const mine = outgoing.filter((r) => r.origin === this.deviceId);
        if (mine.length === 0) {
            await this.store.setMeta(CURSOR_PUSH, highWaterMark(mine, since));
            return 0;
        }
        const { accepted } = await this.transport.push({ records: mine, deviceId: this.deviceId });
        await this.store.setMeta(CURSOR_PUSH, highWaterMark(mine, since));
        return accepted;
    }
}
/**
 * Largest `updatedAt` we have sent, so the next pass starts just past it.
 *
 * Sent, not seen: `changedSince` also hands back the records `pull` just
 * merged in, and those carry the *writing* device's clock. Letting one of them
 * move this cursor parks it in the future whenever another device runs fast,
 * and every local write stamped before that point is then invisible to
 * `changedSince` and never leaves this machine. Foreign records never need
 * covering here — they are filtered out of the push anyway.
 */
function highWaterMark(records, fallback) {
    return records.reduce((max, r) => (r.updatedAt > max ? r.updatedAt : max), fallback);
}
