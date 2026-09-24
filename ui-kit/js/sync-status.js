/**
 * <sc-sync-status> — the sync readout every app shows in its sidebar foot.
 *
 *   <script type="module" src="../ui-kit/js/sync-status.js"></script>
 *   <sc-sync-status></sc-sync-status>
 *
 * Shows the phase (idle, syncing, error), when the last sync finished, how many
 * records it pulled and pushed, and a "Sync now" button. Light DOM, kit
 * classes, no dependencies. It knows nothing about sync-kit and never imports
 * it: the two talk through window events, so a page can load either first.
 *
 *   status in    window.dispatchEvent(new CustomEvent('sync-kit:status', { detail: status }))
 *                or  element.status = status
 *   sync out     window.addEventListener('sync-kit:sync-now', () => sync())
 *
 *   status = {
 *     phase: 'idle' | 'syncing' | 'error',
 *     lastSyncAt?: string | number | Date | null,   when the last sync finished
 *     lastError?: string | null,                    shown while phase is 'error'
 *     pulled?: number, pushed?: number,             record counts of the last run
 *     label?: string,                               which workspace or server, if it matters
 *   }
 *
 * The latest status wins whichever way it arrives, and an element added after
 * the last event starts from that event, so late-mounted readouts are right.
 * Add `no-button` to hide the button where there is no room for it.
 *
 * From React 18: React writes attributes, not properties, on custom elements,
 * so set the property through a ref in an effect, and listen with
 * addEventListener:
 *
 *   const ref = useRef(null);
 *   useEffect(() => { ref.current.status = status; }, [status]);
 *   useEffect(() => {
 *     const onSyncNow = () => sync();
 *     window.addEventListener('sync-kit:sync-now', onSyncNow);
 *     return () => window.removeEventListener('sync-kit:sync-now', onSyncNow);
 *   }, []);
 *   <sc-sync-status ref={ref} />
 *
 * When sync-kit already dispatches 'sync-kit:status' itself, the ref effect is
 * not needed at all.
 */

const STATUS_EVENT = 'sync-kit:status';
const SYNC_NOW_EVENT = 'sync-kit:sync-now';
const PHASES = ['idle', 'syncing', 'error'];

/** The last status seen on window, so an element mounted later starts from it. */
let lastStatus = null;
if (typeof window !== 'undefined') {
  window.addEventListener(STATUS_EVENT, (e) => {
    lastStatus = normalize(e.detail);
  });
}

function normalize(value) {
  if (!value || typeof value !== 'object') return null;
  const s = { ...value };
  if (!PHASES.includes(s.phase)) s.phase = 'idle';
  return s;
}

function toDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "just now", "4 min ago", "3 h ago", "yesterday", "5 days ago", "12 Sep". */
export function relativeTime(date, now = new Date()) {
  const s = Math.round((now - date) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function phaseWord(phase, synced) {
  if (phase === 'syncing') return 'Syncing';
  if (phase === 'error') return 'Sync failed';
  return synced ? 'Synced' : 'Not synced';
}

export class ScSyncStatus extends HTMLElement {
  static get observedAttributes() {
    return ['no-button'];
  }

  constructor() {
    super();
    this._status = null;
    this._own = false;
    this._timer = 0;
    this._onStatus = (e) => {
      this.status = e.detail;
    };
    this._onClick = (e) => {
      if (e.target.closest('[data-sync-now]')) window.dispatchEvent(new CustomEvent(SYNC_NOW_EVENT));
    };
  }

  /** The status object being shown; null when nothing has arrived yet. */
  get status() {
    return this._status;
  }

  set status(value) {
    this._status = normalize(value);
    this._own = true;
    this.render();
  }

  connectedCallback() {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'status');
    if (!this._own && lastStatus) this._status = lastStatus;
    window.addEventListener(STATUS_EVENT, this._onStatus);
    this.addEventListener('click', this._onClick);
    // Keeps "4 min ago" honest without any event arriving.
    this._timer = setInterval(() => this.renderDetail(), 30_000);
    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener(STATUS_EVENT, this._onStatus);
    this.removeEventListener('click', this._onClick);
    clearInterval(this._timer);
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  render() {
    const s = this._status || { phase: 'idle' };
    const synced = Boolean(toDate(s.lastSyncAt));
    this.dataset.phase = s.phase;
    this.toggleAttribute('data-synced', synced);
    const button = this.hasAttribute('no-button')
      ? ''
      : `<button type="button" class="sc-button sc-button--ghost sc-button--sm" data-sync-now ${s.phase === 'syncing' ? 'disabled' : ''}>Sync now</button>`;
    this.innerHTML = `
      <span class="sc-sync-dot" aria-hidden="true"></span>
      <span class="sc-sync-phase">${phaseWord(s.phase, synced)}</span>
      <span class="sc-sync-detail"></span>
      ${button}`;
    this.renderDetail();
  }

  /** Only the text that changes with time; called on a timer. */
  renderDetail() {
    const detail = this.querySelector('.sc-sync-detail');
    if (!detail) return;
    const s = this._status || { phase: 'idle' };
    const last = toDate(s.lastSyncAt);
    const parts = [];
    if (s.phase === 'error') parts.push(s.lastError || 'error');
    else if (s.phase === 'syncing') parts.push('in progress');
    else if (last) parts.push(relativeTime(last));
    if (s.phase !== 'error' && (s.pulled || s.pushed)) parts.push(`↓${s.pulled ?? 0} ↑${s.pushed ?? 0}`);
    if (s.label) parts.push(String(s.label));
    detail.textContent = parts.join(' · ');
    this.title = [
      phaseWord(s.phase, Boolean(last)),
      last ? `Last sync ${last.toLocaleString()}` : '',
      s.phase === 'error' && s.lastError ? String(s.lastError) : '',
      s.label ? `Workspace: ${s.label}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
}

if (!customElements.get('sc-sync-status')) customElements.define('sc-sync-status', ScSyncStatus);
