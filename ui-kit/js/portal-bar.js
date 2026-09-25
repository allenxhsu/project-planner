/**
 * <sc-portal-bar> — the Portal's slim bar above an app shell.
 *
 *   <script type="module" src="ui-kit/js/portal-bar.js"></script>
 *   <sc-portal-bar app="idef0"></sc-portal-bar>
 *   <div class="sc-shell">…</div>
 *
 * Inside the Portal every app is served on one origin under /<app>/ behind
 * Sign in with Google, and this bar is the piece of the Portal each app
 * carries: the app switcher (every app's two-letter mark in its identity
 * colour, the current app lit, each linking to /<id>/), the account (initial
 * and email) and Sign out (POST /logout, then reload).
 *
 * Attributes: `src` (default /auth/me) is fetched with the session cookie and
 * answers the roster; `app` is this app's id.
 *
 * It never blocks the app. It renders at once from the last roster cached in
 * localStorage under `toolkit.session`, then fetches; a request still hanging
 * after 8 s is abandoned. Offline (navigator.onLine false, the fetch failing,
 * or no usable answer) or on 401 it keeps rendering from that cache and shows
 * a Sign in link to /?next=<current path>. Every successful fetch rewrites the
 * cache; Sign out clears it. It does not import sync-kit: both kits read the
 * same key and the same shape,
 *
 *   { email, workspaces, apps: [{ id, name, mark, color, path }] }
 *
 * Properties: `session` (the roster in use; set it to render without a
 * fetch), `state` ('loading' | 'online' | 'signed-out' | 'offline'),
 * `refresh()`, and `fetch` (the function used to load `src`; tests and the
 * gallery hand in a stub). 'sc-portal-session' bubbles with { state, session }
 * whenever the state changes.
 *
 * From React 18: <sc-portal-bar app={APP_ID} /> is enough, since both inputs
 * are attributes. To follow the session, keep a ref and call
 * addEventListener('sc-portal-session', …) in an effect; to hand in a roster
 * you already hold, set ref.current.session in that effect too.
 */

export const SESSION_KEY = 'toolkit.session';
const DEFAULT_SRC = '/auth/me';
const SIGN_IN = '/';
const LOGOUT = '/logout';
const TIMEOUT_MS = 8000;
const COLOR = /^(#[0-9a-f]{3,8}|var\(--[\w-]+\)|(rgb|hsl)a?\([\d\s,.%/deg-]+\))$/i;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const initial = (email) => (email && email[0] ? email[0].toUpperCase() : '?');

/** The roster as the bar uses it, with safe fallbacks; null when there is no apps array. */
export function normalizeSession(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.apps)) return null;
  return {
    email: typeof value.email === 'string' ? value.email : '',
    workspaces: Array.isArray(value.workspaces) ? value.workspaces : [],
    apps: value.apps
      .filter((a) => a && a.id != null)
      .map((a) => {
        const id = String(a.id);
        const name = a.name ? String(a.name) : id;
        return {
          id,
          name,
          mark: String(a.mark || name.slice(0, 2)).toUpperCase(),
          color: COLOR.test(String(a.color || '')) ? String(a.color) : `var(--sc-app-${id})`,
          path: typeof a.path === 'string' && a.path.startsWith('/') ? a.path : `/${id}/`,
        };
      }),
  };
}

/** The Portal's sign-in URL that returns to the current page afterwards. */
export function signInUrl(loc = window.location) {
  return `${SIGN_IN}?next=${encodeURIComponent(loc.pathname + loc.search + loc.hash)}`;
}

/** The cached roster, or null. sync-kit reads the same key. */
export function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? normalizeSession(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* the bar works without a cache; it just starts empty next time */
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* nothing to clear */
  }
}

export class ScPortalBar extends HTMLElement {
  static get observedAttributes() {
    return ['src', 'app'];
  }

  constructor() {
    super();
    this._session = null;
    this._state = 'loading';
    this._fetch = null;
    this._abort = null;
    this._onOnline = () => this.refresh();
    this._onOffline = () => this.setState('offline');
    this._onClick = (e) => {
      if (e.target.closest('[data-sign-out]')) this.signOut();
    };
  }

  /** The roster in use. Setting one renders it as signed in and caches it. */
  get session() {
    return this._session;
  }

  set session(value) {
    const session = normalizeSession(value);
    this._session = session;
    if (session) writeSession(session);
    this.setState(session ? 'online' : 'signed-out');
  }

  get state() {
    return this._state;
  }

  /** The function used to load `src`; window.fetch unless a stub is handed in. */
  get fetch() {
    return this._fetch || ((...args) => window.fetch(...args));
  }

  set fetch(fn) {
    this._fetch = typeof fn === 'function' ? fn : null;
  }

  connectedCallback() {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'navigation');
    if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', 'Toolkit');
    this.addEventListener('click', this._onClick);
    window.addEventListener('online', this._onOnline);
    window.addEventListener('offline', this._onOffline);
    if (!this._session) this._session = readSession();
    this.render();
    this.refresh();
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick);
    window.removeEventListener('online', this._onOnline);
    window.removeEventListener('offline', this._onOffline);
    this._abort?.abort();
    this._abort = null;
  }

  attributeChangedCallback(name) {
    if (!this.isConnected) return;
    if (name === 'src') this.refresh();
    else this.render();
  }

  setState(state) {
    const changed = state !== this._state;
    this._state = state;
    this.render();
    if (changed) {
      this.dispatchEvent(new CustomEvent('sc-portal-session', { bubbles: true, detail: { state, session: this._session } }));
    }
  }

  /** Loads `src` again. Settles the bar and never rejects. */
  async refresh() {
    this._abort?.abort();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this._abort = null;
      this.setState('offline');
      return;
    }
    const controller = new AbortController();
    this._abort = controller;
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetch(this.getAttribute('src') || DEFAULT_SRC, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (this._abort !== controller) return; // a newer refresh took over
      if (res.status === 401 || res.status === 403) {
        this.setState('signed-out');
        return;
      }
      if (!res.ok) {
        this.setState('offline');
        return;
      }
      const session = normalizeSession(await res.json());
      if (this._abort !== controller) return;
      if (!session) {
        this.setState('offline');
        return;
      }
      this._session = session;
      writeSession(session);
      this.setState('online');
    } catch {
      if (this._abort === controller) this.setState('offline');
    } finally {
      clearTimeout(timer);
      if (this._abort === controller) this._abort = null;
    }
  }

  /** POST /logout, forget the cached roster, reload. */
  async signOut() {
    try {
      await this.fetch(LOGOUT, { method: 'POST', credentials: 'same-origin' });
    } catch {
      /* the reload lands on the Portal's sign-in page either way */
    }
    clearSession();
    this._session = null;
    window.location.reload();
  }

  render() {
    const session = this._session;
    const current = this.getAttribute('app') || '';
    const state = this._state;
    this.dataset.state = state;

    const switcher = (session ? session.apps : [])
      .map((a) => {
        const active = a.id === current;
        return `<a class="sc-portal-app${active ? ' is-active' : ''}" href="${escapeHtml(a.path)}" style="--tint:${escapeHtml(a.color)}" title="${escapeHtml(a.name)}"${active ? ' aria-current="page"' : ''}>${escapeHtml(a.mark)}</a>`;
      })
      .join('');

    let account = '';
    if (state === 'online' && session) {
      account = `
        <span class="sc-portal-avatar" aria-hidden="true">${escapeHtml(initial(session.email))}</span>
        <span class="sc-portal-email" title="${escapeHtml(session.email)}">${escapeHtml(session.email)}</span>
        <button type="button" class="sc-button sc-button--ghost sc-button--sm" data-sign-out>Sign out</button>`;
    } else if (state === 'loading') {
      account = session && session.email ? `<span class="sc-portal-email sc-faint">${escapeHtml(session.email)}</span>` : '';
    } else {
      const offline = state === 'offline';
      const who = offline && session && session.email ? `<span class="sc-portal-email sc-faint" title="${escapeHtml(session.email)}">${escapeHtml(session.email)}</span>` : '';
      account = `
        ${offline ? '<span class="sc-pill" style="--tint:var(--sc-warning)">Offline</span>' : '<span class="sc-pill" style="--tint:var(--sc-text-3)">Signed out</span>'}
        ${who}
        <a class="sc-button sc-button--ghost sc-button--sm" href="${escapeHtml(signInUrl())}">Sign in</a>`;
    }

    this.innerHTML = `
      <a class="sc-portal-home" href="${SIGN_IN}" title="Portal home">Toolkit</a>
      <nav class="sc-portal-apps" aria-label="Apps">${switcher}</nav>
      <span class="sc-portal-account">${account}</span>`;
  }
}

if (!customElements.get('sc-portal-bar')) customElements.define('sc-portal-bar', ScPortalBar);
