/**
 * The seam between sync-kit and ui-kit.
 *
 * ui-kit's `<sc-sync-status>` shows a spinner, a relative time and an error,
 * and neither kit imports the other — so the contract between them is two DOM
 * events on `window` rather than a shared type. An app that wires nothing gets
 * the events anyway and ignores them.
 *
 * Every function here is a no-op outside a browser. The same modules run in
 * the server's convergence test under Node, where there is no `window` and a
 * missing guard would be a crash rather than a missing spinner.
 */
import type { SyncPhase } from './engine.js';
export declare const SYNC_EVENTS: {
    /** We fire this. `detail` is `SyncStatusDetail`. */
    readonly status: 'sync-kit:status';
    /** Anyone fires this — a toolbar button, a keyboard shortcut — and we sync. */
    readonly syncNow: 'sync-kit:sync-now';
};
/**
 * What a status listener receives.
 *
 * Looser than the engine's own `SyncStatus`: `lastSyncAt` accepts whatever a
 * hand-rolled dispatcher finds convenient, because an app that syncs through
 * something other than `SyncEngine` should still be able to drive the widget.
 */
export interface SyncStatusDetail {
    phase: SyncPhase;
    lastSyncAt?: string | number | Date | null;
    lastError?: string | null;
    /** `unauthorized` when the remote refused the credential; see `SyncStatus`. */
    lastErrorCode?: 'unauthorized' | null;
    /** The last run's, not a running total. */
    pulled?: number;
    pushed?: number;
    /**
     * Which server or workspace this status is about, for an app that syncs with
     * more than one. Shown muted after the phase and in the tooltip. Something a
     * person would recognise — a workspace name, a host — never a URL carrying a
     * token, because this ends up in the DOM.
     */
    label?: string;
}
export declare function publishStatus(detail: SyncStatusDetail): void;
/** Asks whoever is listening to sync. Returns false when nothing could hear. */
export declare function requestSync(): boolean;
/** Subscribes to sync-now. The returned function unsubscribes. */
export declare function onSyncNow(handler: () => void): () => void;
