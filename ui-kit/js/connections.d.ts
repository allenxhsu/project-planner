/** <sc-connections>: the Connections panel. See connections.js for the contract. */
export interface ConnectedAccount {
  id: string;
  label: string;
  connectedAt: number | null;
  /** The features granted: calendar, drive, sheets; activities. */
  features: string[];
}

export interface ConnectionProvider {
  id: string;
  name: string;
  /** Whether the sync server is set up for this provider at all. */
  configured: boolean;
  /** The features the server can ask for. */
  features: string[];
  accounts: ConnectedAccount[];
}

export type ConnectionsState = 'loading' | 'ready' | 'unauthorized' | 'unavailable' | 'error';

export interface ConnectionsModel {
  state: ConnectionsState;
  providers: ConnectionProvider[] | null;
  error?: string | null;
}

export interface RenderOptions {
  /** The server's origin when it is not the page's. */
  origin?: string;
  /** Only these providers. */
  providers?: string[];
  /** What Connect asks for, per provider: { google: ['calendar', 'drive'] }. */
  features?: Record<string, string[]>;
}

export class ScConnections extends HTMLElement {
  /** A request to the server, as the app makes them. Default: fetch with the same-origin cookie. */
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** The server, when it is not this page's origin. */
  origin: string;
  /** Opens the consent screen; false when it could not. Default: a small window. */
  open: (url: string) => boolean;
  /** The last list read; null until one arrives. */
  readonly connections: ConnectionProvider[] | null;
  refresh(): Promise<void>;
}

export function normalizeConnections(value: unknown): ConnectionProvider[] | null;
export function renderConnections(model: ConnectionsModel, opts?: RenderOptions): string;
export function startUrl(origin: string, provider: string, features?: string[]): string;
export function describeFeatures(features: string[]): string;

declare global {
  interface HTMLElementTagNameMap {
    'sc-connections': ScConnections;
  }
  interface HTMLElementEventMap {
    'sc-connections': CustomEvent<{ state: ConnectionsState; providers: ConnectionProvider[] | null }>;
  }
  namespace JSX {
    interface IntrinsicElements {
      'sc-connections': { [attribute: string]: unknown };
    }
  }
}
