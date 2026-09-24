/** <sc-sync-status>: the sync readout. See sync-status.js for the event contract. */
export type SyncPhase = 'idle' | 'syncing' | 'error';

export interface SyncStatus {
  phase: SyncPhase;
  /** When the last sync finished; ISO string, epoch ms or Date. */
  lastSyncAt?: string | number | Date | null;
  /** Shown while phase is 'error'. */
  lastError?: string | null;
  /** Record counts of the last run. */
  pulled?: number;
  pushed?: number;
  /** Which workspace or server the status belongs to, when it matters. */
  label?: string;
}

export class ScSyncStatus extends HTMLElement {
  /** The status being shown. Setting it re-renders; window 'sync-kit:status' events also set it. */
  status: SyncStatus | null;
}

/** "just now", "4 min ago", "3 h ago", "yesterday", "5 days ago", "12 Sep". */
export function relativeTime(date: Date, now?: Date): string;

declare global {
  interface HTMLElementTagNameMap {
    'sc-sync-status': ScSyncStatus;
  }
  interface WindowEventMap {
    'sync-kit:status': CustomEvent<SyncStatus>;
    'sync-kit:sync-now': CustomEvent<void>;
  }
  namespace JSX {
    interface IntrinsicElements {
      'sc-sync-status': { [attribute: string]: unknown };
    }
  }
}
