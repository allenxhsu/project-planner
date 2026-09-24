export const SYNC_EVENTS = {
    /** We fire this. `detail` is `SyncStatusDetail`. */
    status: 'sync-kit:status',
    /** Anyone fires this — a toolbar button, a keyboard shortcut — and we sync. */
    syncNow: 'sync-kit:sync-now',
};
function browser() {
    return typeof window !== 'undefined' && typeof window.dispatchEvent === 'function';
}
export function publishStatus(detail) {
    if (!browser())
        return;
    window.dispatchEvent(new CustomEvent(SYNC_EVENTS.status, { detail }));
}
/** Asks whoever is listening to sync. Returns false when nothing could hear. */
export function requestSync() {
    if (!browser())
        return false;
    window.dispatchEvent(new CustomEvent(SYNC_EVENTS.syncNow));
    return true;
}
/** Subscribes to sync-now. The returned function unsubscribes. */
export function onSyncNow(handler) {
    if (!browser())
        return () => { };
    const listener = () => handler();
    window.addEventListener(SYNC_EVENTS.syncNow, listener);
    return () => window.removeEventListener(SYNC_EVENTS.syncNow, listener);
}
