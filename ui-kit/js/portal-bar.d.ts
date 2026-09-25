/** <sc-portal-bar>: the Portal's slim bar above an app shell. See portal-bar.js. */
export interface PortalApp {
  id: string;
  name: string;
  /** Two letters, upper case. */
  mark: string;
  /** A CSS colour: the app's identity colour from tokens.json, or a var(--sc-app-<id>) fallback. */
  color: string;
  /** Same-origin path, /<id>/ by default. */
  path: string;
}

/** The roster /auth/me answers and both kits cache under localStorage 'toolkit.session'. */
export interface PortalSession {
  email: string;
  workspaces: unknown[];
  apps: PortalApp[];
}

export type PortalState = 'loading' | 'online' | 'signed-out' | 'offline';

export const SESSION_KEY: 'toolkit.session';

/** The roster as the bar uses it, with safe fallbacks; null when there is no apps array. */
export function normalizeSession(value: unknown): PortalSession | null;
/** The cached roster, or null. */
export function readSession(): PortalSession | null;
/** /?next=<current path>: the Portal's sign-in URL that returns here afterwards. */
export function signInUrl(location?: Location): string;

export class ScPortalBar extends HTMLElement {
  /** The roster in use. Setting one renders it as signed in and caches it. */
  session: PortalSession | null;
  readonly state: PortalState;
  /** The function used to load `src`; window.fetch unless a stub is handed in. */
  fetch: typeof globalThis.fetch;
  /** Loads `src` again. Settles the bar and never rejects. */
  refresh(): Promise<void>;
  /** POST /logout, forget the cached roster, reload. */
  signOut(): Promise<void>;
}

declare global {
  interface HTMLElementTagNameMap {
    'sc-portal-bar': ScPortalBar;
  }
  interface HTMLElementEventMap {
    'sc-portal-session': CustomEvent<{ state: PortalState; session: PortalSession | null }>;
  }
  namespace JSX {
    interface IntrinsicElements {
      'sc-portal-bar': { [attribute: string]: unknown };
    }
  }
}
