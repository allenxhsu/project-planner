"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYNC_EVENTS = void 0;
exports.publishStatus = publishStatus;
exports.requestSync = requestSync;
exports.onSyncNow = onSyncNow;
exports.SYNC_EVENTS = {
    /** We fire this. `detail` is `SyncStatusDetail`. */
    status: 'sync-kit:status',
    /** Anyone fires this — a toolbar button, a keyboard shortcut — and we sync. */
    syncNow: 'sync-kit:sync-now',
};
function browser() {
    return typeof window !== 'undefined' && typeof window.dispatchEvent === 'function';
}
function publishStatus(detail) {
    if (!browser())
        return;
    window.dispatchEvent(new CustomEvent(exports.SYNC_EVENTS.status, { detail }));
}
/** Asks whoever is listening to sync. Returns false when nothing could hear. */
function requestSync() {
    if (!browser())
        return false;
    window.dispatchEvent(new CustomEvent(exports.SYNC_EVENTS.syncNow));
    return true;
}
/** Subscribes to sync-now. The returned function unsubscribes. */
function onSyncNow(handler) {
    if (!browser())
        return () => { };
    const listener = () => handler();
    window.addEventListener(exports.SYNC_EVENTS.syncNow, listener);
    return () => window.removeEventListener(exports.SYNC_EVENTS.syncNow, listener);
}
