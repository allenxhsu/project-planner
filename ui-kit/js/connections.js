/**
 * <sc-connections> — the Connections panel every app's Settings shows.
 *
 *   <script type="module" src="ui-kit/js/connections.js"></script>
 *   <sc-connections></sc-connections>
 *
 * A connection is made once, on the sync server, on a person's behalf —
 * Strava, a Google account — and from then on every app reads through it
 * with the credential it already has. This panel is the one list: each
 * provider as a block, the accounts connected with the features each was
 * granted, a Connect button (Strava's consent screen; Google's with the
 * features the app asks for), Disconnect per account. What an app does with
 * a connection is the app's business; this only shows and starts them.
 *
 * Attributes: `providers` ("google,strava"; default all the server lists),
 * `features` (what Connect Google asks for: "calendar,drive,sheets";
 * default calendar — an account that lacks one of them is offered an Add
 * button), `src` (the list; default /connect).
 *
 * Properties, for apps that reach their server some other way than the
 * same-origin cookie: `request(path, init)` returns a Response for a server
 * path (default: fetch with the cookie); `origin` is the server when it is
 * not this page's (the consent screen opens there); `open(url)` opens the
 * consent screen (default: a small window) — a Mac-hosted page hands it to
 * the shell. `connections` is the last model read; `refresh()` reads again.
 *
 * It never blocks the app: it renders at once, then fetches; a 401 shows a
 * Sign in link; a request that fails says so with a Retry. The provider's
 * finish page posts {type:"connected", provider} to its opener, which
 * refreshes the list; so does the window regaining focus, since a Mac shell
 * opens the consent screen in the default browser instead.
 *
 * 'sc-connections' bubbles with { state, providers } whenever the list
 * changes. Children the app puts inside the element stay after the list.
 */

const DEFAULT_SRC = '/connect';
const TIMEOUT_MS = 10_000;
const FEATURE_NAMES = { calendar: 'Calendar', drive: 'Drive', sheets: 'Sheets', activities: 'Activities' };
const NOTES = {
  google: 'The calendar as busy time, and when asked for, Drive files and spreadsheets — read-only.',
  strava: 'Rides, snowboard days, lifts: every activity, read-only.',
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Calendar, Drive, Sheets, Activities — or the id itself when it is new here. */
export function describeFeatures(features) {
  return (features || []).map((f) => FEATURE_NAMES[f] || f).join(', ');
}

/** /connect/<provider>/start on the server named, with the features Google is asked for. */
export function startUrl(origin, provider, features = []) {
  const q = provider === 'google' && features.length ? `?features=${encodeURIComponent(features.join(','))}` : '';
  return `${origin || ''}/connect/${encodeURIComponent(provider)}/start${q}`;
}

/** The server's list as the panel uses it, with safe fallbacks; null when there is no list. */
export function normalizeConnections(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.providers)) return null;
  return value.providers
    .filter((p) => p && p.id != null)
    .map((p) => ({
      id: String(p.id),
      name: typeof p.name === 'string' && p.name ? p.name : String(p.id),
      configured: p.configured === true,
      features: Array.isArray(p.features) ? p.features.map(String) : [],
      accounts: (Array.isArray(p.accounts) ? p.accounts : [])
        .filter((a) => a && a.id != null)
        .map((a) => ({
          id: String(a.id),
          label: typeof a.label === 'string' && a.label ? a.label : String(a.id),
          connectedAt: Number.isFinite(a.connectedAt) ? a.connectedAt : null,
          features: Array.isArray(a.features) ? a.features.map(String) : [],
        })),
    }));
}

const when = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function renderProvider(p, opts) {
  const wanted = (opts.features && opts.features[p.id]) || (p.id === 'google' ? ['calendar'] : p.features);
  const verb = p.id === 'google' ? (p.accounts.length ? 'Connect another Google account' : 'Connect a Google account') : `Connect ${p.name}`;
  const accounts = p.accounts.map((a) => {
    const missing = wanted.filter((f) => !a.features.includes(f));
    return `<div class="sc-connections-account">
      <span class="sc-connections-who"><strong>${escapeHtml(a.label)}</strong><span class="sc-faint small">${a.connectedAt ? ` · connected ${escapeHtml(when(a.connectedAt))}` : ''}</span></span>
      <span class="sc-connections-features">${a.features.map((f) => `<span class="sc-connections-chip">${escapeHtml(FEATURE_NAMES[f] || f)}</span>`).join('')}</span>
      ${missing.length ? `<button type="button" class="sc-button sc-button--sm" data-connect="${escapeHtml(p.id)}" data-features="${escapeHtml(wanted.join(','))}" data-hint="${escapeHtml(a.id)}">Add ${escapeHtml(describeFeatures(missing))}</button>` : ''}
      <button type="button" class="sc-button sc-button--ghost sc-button--sm" data-disconnect="${escapeHtml(p.id)}" data-account="${escapeHtml(a.id)}">Disconnect</button>
    </div>`;
  }).join('');
  return `<section class="sc-connections-provider" data-provider="${escapeHtml(p.id)}">
    <div class="sc-connections-head"><span class="sc-label">${escapeHtml(p.name)}</span><span class="sc-faint small">${escapeHtml(NOTES[p.id] || describeFeatures(p.features))}</span></div>
    ${p.configured ? '' : `<p class="sc-alert sc-alert--warning small">This sync server is not set up for ${escapeHtml(p.name)} yet${p.id === 'strava' ? ' (it needs a Strava API app: STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET)' : ' (it has no Google client secret)'}.</p>`}
    ${accounts || `<p class="sc-muted small sc-connections-empty">Nothing connected yet.</p>`}
    <div class="sc-connections-actions">
      <button type="button" class="sc-button sc-button--sm sc-button--primary" data-connect="${escapeHtml(p.id)}" data-features="${escapeHtml(wanted.join(','))}"${p.configured ? '' : ' disabled'}>${escapeHtml(verb)}</button>
    </div>
  </section>`;
}

/** The whole panel for a model { state, providers, error }; pure, so it can be checked without a DOM. */
export function renderConnections(model, opts = {}) {
  const { state, providers } = model;
  if (state === 'loading' && !providers) return '<p class="sc-faint small sc-connections-note">Asking your sync server…</p>';
  if (state === 'unauthorized') {
    const next = typeof window !== 'undefined' && window.location ? window.location.pathname + window.location.search + window.location.hash : '/';
    return `<p class="sc-alert sc-alert--warning small">Sign in to your sync server first — it is where connections are kept. <a class="sc-sync-action" href="/?next=${encodeURIComponent(next)}">Sign in</a></p>`;
  }
  if (state === 'unavailable') return '<p class="sc-alert sc-alert--warning small">Connections live on your sync server, and this page has no sync server: turn sync on (or pair this Mac) first.</p>';
  if (state === 'error' && !providers) {
    return `<p class="sc-alert sc-alert--danger small">The server could not list connections: ${escapeHtml(model.error || 'unknown error')}. <button type="button" class="sc-button sc-button--ghost sc-button--sm" data-refresh>Retry</button></p>`;
  }
  const shown = opts.providers && opts.providers.length ? providers.filter((p) => opts.providers.includes(p.id)) : providers;
  const blocks = shown.map((p) => renderProvider(p, opts)).join('');
  const foot = `<div class="sc-connections-foot">
    ${state === 'error' ? `<span class="sc-alert sc-alert--danger small">${escapeHtml(model.error || 'The server could not be reached')}</span>` : ''}
    <button type="button" class="sc-button sc-button--ghost sc-button--sm" data-refresh>↻ Refresh</button>
    ${state === 'loading' ? '<span class="sc-faint small">Refreshing…</span>' : ''}
  </div>`;
  return blocks + foot;
}

/** Node has no HTMLElement; the render functions above are what a test imports. */
const Base = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

export class ScConnections extends Base {
  static get observedAttributes() {
    return ['providers', 'features', 'src'];
  }

  constructor() {
    super();
    this._model = { state: 'loading', providers: null, error: null };
    this._list = null;
    this._live = false;
    this._abort = null;
    this._lastRefresh = 0;
    /** A request to the server, as the app makes them; the default is the same-origin cookie. */
    this.request = (path, init = {}) => fetch(`${this.origin || ''}${path}`, { credentials: 'include', ...init });
    /** The server, when it is not this page's origin. */
    this.origin = '';
    /** How the consent screen opens: a small window, unless the app says otherwise. */
    this.open = (url) => { const w = window.open(url, 'sc-connect', 'width=560,height=760'); return !!w; };
    this._onClick = (e) => this._click(e);
    this._onMessage = (e) => { if (e.data && (e.data.type === 'connected' || e.data.type === 'calendar-connected')) void this.refresh(); };
    this._onFocus = () => { if (Date.now() - this._lastRefresh > 2000) void this.refresh(); };
  }

  get connections() { return this._model.providers; }

  connectedCallback() {
    if (!this._list) {
      this._list = document.createElement('div');
      this._list.className = 'sc-connections-list';
      this.prepend(this._list);
    }
    this.addEventListener('click', this._onClick);
    window.addEventListener('message', this._onMessage);
    window.addEventListener('focus', this._onFocus);
    this._live = true;
    this.render();
    void this.refresh();
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick);
    window.removeEventListener('message', this._onMessage);
    window.removeEventListener('focus', this._onFocus);
    this._abort?.abort();
    this._live = false;
  }

  attributeChangedCallback(name) {
    if (!this._live) return;
    if (name === 'src') void this.refresh();
    else this.render();
  }

  _opts() {
    const providers = (this.getAttribute('providers') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const google = (this.getAttribute('features') || 'calendar').split(',').map((s) => s.trim()).filter(Boolean);
    return { origin: this.origin, providers, features: { google } };
  }

  setModel(next) {
    this._model = { ...this._model, ...next };
    this.render();
    this.dispatchEvent(new CustomEvent('sc-connections', { bubbles: true, detail: { state: this._model.state, providers: this._model.providers } }));
  }

  render() {
    if (this._list) this._list.innerHTML = renderConnections(this._model, this._opts());
  }

  /** Reads the list again. Settles the panel and never rejects. */
  async refresh() {
    this._abort?.abort();
    const controller = new AbortController();
    this._abort = controller;
    this._lastRefresh = Date.now();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    this.setModel({ state: 'loading' });
    try {
      const res = await this.request(this.getAttribute('src') || DEFAULT_SRC, { headers: { accept: 'application/json' }, signal: controller.signal });
      if (this._abort !== controller) return;
      if (res.status === 401 || res.status === 403) return this.setModel({ state: 'unauthorized', providers: null });
      if (!res.ok) return this.setModel({ state: 'error', error: `the server answered ${res.status}` });
      const providers = normalizeConnections(await res.json());
      if (!providers) return this.setModel({ state: 'error', error: 'the answer was not a list of providers' });
      this.setModel({ state: 'ready', providers, error: null });
    } catch (err) {
      if (this._abort !== controller) return;
      const msg = err && err.message ? err.message : String(err);
      this.setModel({ state: /no sync server|turn sync on|pair this mac/i.test(msg) ? 'unavailable' : 'error', error: msg });
    } finally {
      clearTimeout(timer);
      if (this._abort === controller) this._abort = null;
    }
  }

  async _click(e) {
    const connect = e.target.closest('[data-connect]');
    if (connect) {
      const features = (connect.dataset.features || '').split(',').filter(Boolean);
      let url = startUrl(this.origin, connect.dataset.connect, features);
      if (connect.dataset.hint) url += `${url.includes('?') ? '&' : '?'}hint=${encodeURIComponent(connect.dataset.hint)}`;
      if (!this.open(url)) this.setModel({ state: 'error', error: 'the sign-in window was blocked; allow pop-ups for this page' });
      return;
    }
    const disconnect = e.target.closest('[data-disconnect]');
    if (disconnect) {
      const { disconnect: provider, account } = disconnect.dataset;
      const label = this._model.providers?.find((p) => p.id === provider)?.accounts.find((a) => a.id === account)?.label || account;
      if (!(await this._confirm(`Disconnect ${label}?`, 'The server forgets its access, and the provider is told so. Nothing already brought into an app is removed.'))) return;
      try {
        const res = await this.request(`/connect/${encodeURIComponent(provider)}/accounts/${encodeURIComponent(account)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 404) this.setModel({ state: 'error', error: `the server answered ${res.status}` });
      } catch (err) {
        this.setModel({ state: 'error', error: err && err.message ? err.message : String(err) });
      }
      void this.refresh();
      return;
    }
    if (e.target.closest('[data-refresh]')) void this.refresh();
  }

  /** <sc-dialog> when the page has it, the browser's own box when not. */
  async _confirm(heading, text) {
    const Dialog = customElements.get('sc-dialog');
    if (Dialog && typeof Dialog.open === 'function') {
      const id = await Dialog.open({ heading, body: `<p>${escapeHtml(text)}</p>`, buttons: [{ id: 'cancel', label: 'Cancel', kind: 'ghost' }, { id: 'ok', label: 'Disconnect', kind: 'danger' }] });
      return id === 'ok';
    }
    return window.confirm(`${heading}\n\n${text}`);
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('sc-connections')) {
  customElements.define('sc-connections', ScConnections);
}
