/**
 * Template app logic: navigation between views, and the views themselves.
 *
 * Deliberately framework-free so it drops into the no-build apps (IDEF0,
 * Metropolis) as-is. A React app keeps the same markup and class names inside
 * its components; see ../README.md.
 */

const NAV = [
  { id: 'overview', label: 'Overview', glyph: '◈', tint: 'var(--sc-accent)', count: null },
  { id: 'components', label: 'Components', glyph: '▣', tint: 'var(--sc-app)', count: 18 },
  { id: 'settings', label: 'Settings', glyph: '⚙', tint: 'var(--sc-accent-2)', count: null },
];

const WORKSPACE = ['Market entry recommendation', 'Q3 supplier review', 'Process gap analysis', 'Hiring plan 2027'];

const history = [];
const future = [];
let current = 'overview';

const $ = (sel) => document.querySelector(sel);

function renderNav() {
  $('#nav').innerHTML = NAV.map(
    (n) => `
      <button class="sc-nav-item ${n.id === current ? 'is-active' : ''}" data-view="${n.id}">
        <span class="sc-nav-icon" style="--tint:${n.tint}">${n.glyph}</span>
        <span class="sc-nav-label">${n.label}</span>
        ${n.count ? `<span class="sc-badge">${n.count}</span>` : ''}
      </button>`,
  ).join('');

  $('#workspace-list').innerHTML = WORKSPACE.map(
    (w, i) => `<div class="sc-list-item ${i === 0 ? 'is-active' : ''}"><span class="sc-faint">▸</span>${w}</div>`,
  ).join('');
}

function go(view, record = true) {
  if (view === current) return;
  if (record) {
    history.push(current);
    future.length = 0;
  }
  current = view;
  render();
}

function render() {
  renderNav();
  $('#view-title').textContent = NAV.find((n) => n.id === current)?.label ?? '';
  $('#view').innerHTML = VIEWS[current]();
  $('#view').scrollTop = 0;
}

const VIEWS = {
  overview: () => `
    <div class="sc-alert sc-alert--warning" style="margin-bottom:20px">
      <strong>Transmission</strong> Two claims in “Market entry recommendation” have no supporting evidence.
    </div>
    <div class="grid">
      ${[
        ['Claims', '42', 72],
        ['Evidence', '118', 88],
        ['Open issues', '7', 18],
      ]
        .map(
          ([label, value, pct]) => `
        <section class="sc-panel sc-panel--lit sc-brackets demo">
          <div class="sc-label">${label}</div>
          <div class="stat sc-glow-text">${value}</div>
          <div class="sc-meter" style="margin-top:10px"><span style="--value:${pct}%"></span></div>
        </section>`,
        )
        .join('')}
    </div>
    <div class="sc-section-title">Recent</div>
    <div class="grid">
      ${WORKSPACE.map(
        (w) => `
        <article class="sc-card sc-brackets sc-brackets--hover">
          <div class="sc-label">Pyramid</div>
          <h3 style="margin:6px 0 8px;font-size:14px">${w}</h3>
          <p class="sc-muted" style="margin:0 0 10px">Governing thought, three key lines, supporting evidence.</p>
          <div class="row"><span class="sc-pill">Draft</span><span class="sc-pill" style="--tint:var(--sc-accent-2)">Review</span></div>
        </article>`,
      ).join('')}
    </div>`,

  components: () => `
    <div class="stack">
      <section class="sc-panel demo">
        <h2>Buttons</h2>
        <div class="row">
          <button class="sc-button sc-button--primary">Primary</button>
          <button class="sc-button">Default</button>
          <button class="sc-button sc-button--ghost">Ghost</button>
          <button class="sc-button sc-button--danger">Delete</button>
          <button class="sc-button" disabled>Disabled</button>
          <button class="sc-button sc-button--icon" title="Add">+</button>
          <button class="sc-button sc-button--sm">Small</button>
        </div>
      </section>

      <section class="sc-panel demo">
        <h2>Form</h2>
        <div class="grid">
          <label class="sc-field"><span>Title</span><input class="sc-input" placeholder="Name this pyramid"></label>
          <label class="sc-field"><span>Type</span>
            <select class="sc-select"><option>Recommendation</option><option>Analysis</option></select>
          </label>
          <label class="sc-field" style="grid-column:1/-1"><span>Governing thought</span>
            <textarea class="sc-textarea" rows="3" placeholder="The one sentence the reader must accept"></textarea>
          </label>
          <label class="row"><input type="checkbox" class="sc-check" checked> <span>Check evidence on save</span></label>
        </div>
      </section>

      <section class="sc-panel demo">
        <h2>Tabs, badges, pills, readouts</h2>
        <div class="sc-tabs" style="margin-bottom:16px">
          <button class="sc-tab is-active">Table</button><button class="sc-tab">Board</button><button class="sc-tab">+ View</button>
        </div>
        <div class="row" style="margin-bottom:14px">
          <span class="sc-badge">12</span><span class="sc-badge sc-badge--alert">99+</span>
          <span class="sc-pill">Use case</span>
          <span class="sc-pill" style="--tint:var(--sc-accent-2)">Workflow</span>
          <span class="sc-pill" style="--tint:var(--sc-success)">Introduction</span>
          <span class="sc-pill" style="--tint:var(--sc-danger)">Blocked</span>
          <span class="sc-kbd">⌘ K</span>
        </div>
        <div class="row" style="gap:24px">
          <span class="sc-resource"><span class="sc-resource-icon"></span>1,284</span>
          <span class="sc-resource sc-resource--alt"><span class="sc-resource-icon"></span>312</span>
          <div class="sc-meter" style="width:220px"><span style="--value:64%"></span></div>
        </div>
      </section>

      <section class="sc-panel demo">
        <h2>Table</h2>
        <table class="sc-table">
          <thead><tr><th>Name</th><th>Type</th><th>Updated</th></tr></thead>
          <tbody>
            <tr><td>Heptabase: Getting Started</td><td><span class="sc-pill" style="--tint:var(--sc-success)">Introduction</span></td><td class="sc-mono sc-muted">2026-09-14</td></tr>
            <tr><td>Project Research Workflow</td><td><span class="sc-pill" style="--tint:var(--sc-accent-2)">Workflow</span></td><td class="sc-mono sc-muted">2026-09-12</td></tr>
            <tr><td>Left Sidebar</td><td><span class="sc-pill">UI Logic</span></td><td class="sc-mono sc-muted">2026-09-02</td></tr>
          </tbody>
        </table>
      </section>

      <section class="sc-panel demo">
        <h2>Alerts</h2>
        <div class="stack">
          <div class="sc-alert"><strong>Info</strong> Sync complete with 3 devices.</div>
          <div class="sc-alert sc-alert--success"><strong>Success</strong> Model exported.</div>
          <div class="sc-alert sc-alert--warning"><strong>Warning</strong> Decomposition has only two boxes.</div>
          <div class="sc-alert sc-alert--danger"><strong>Error</strong> Arrow enters a box on its output side.</div>
        </div>
      </section>

      <section class="sc-panel demo">
        <h2>Menu & dialog</h2>
        <div class="row" style="align-items:flex-start;gap:24px">
          <div class="sc-menu" style="width:220px">
            <button class="sc-menu-item">Rename</button>
            <button class="sc-menu-item">Pin to top</button>
            <div class="sc-menu-sep"></div>
            <button class="sc-menu-item is-danger">Delete</button>
          </div>
          <button class="sc-button sc-button--primary" data-action="dialog">Open dialog</button>
        </div>
      </section>

      <section class="sc-panel demo">
        <h2>Current palette</h2>
        <div class="swatch-row">
          ${['void', 'bg', 'panel', 'panel-2', 'raised', 'line', 'line-strong', 'text', 'text-2', 'accent', 'accent-2', 'app']
            .map((k) => `<div class="swatch" style="background:var(--sc-${k});color:${['text', 'text-2', 'accent', 'accent-2', 'app'].includes(k) ? 'var(--sc-void)' : 'var(--sc-text)'}">${k}</div>`)
            .join('')}
        </div>
      </section>
    </div>`,

  settings: () => `
    <section class="sc-panel sc-panel--lit demo" style="max-width:560px">
      <h2>Appearance</h2>
      <p class="sc-muted" style="margin-top:0">Shared by every toolkit app served from this origin.</p>
      <sc-theme-picker></sc-theme-picker>
    </section>`,
};

function openDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'sc-overlay';
  overlay.innerHTML = `
    <div class="sc-dialog" role="dialog" aria-modal="true">
      <div class="sc-dialog-head"><span class="sc-label" style="color:var(--sc-text)">New pyramid</span>
        <button class="sc-button sc-button--ghost sc-button--icon sc-button--sm" data-close>✕</button></div>
      <div class="sc-dialog-body stack">
        <label class="sc-field"><span>Title</span><input class="sc-input" autofocus placeholder="Untitled"></label>
        <div class="row" style="justify-content:flex-end">
          <button class="sc-button sc-button--ghost" data-close>Cancel</button>
          <button class="sc-button sc-button--primary" data-close>Create</button>
        </div>
      </div>
    </div>`;
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', esc);
    }
  });
  document.body.appendChild(overlay);
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-view], [data-action]');
  if (!el) return;
  if (el.dataset.view) go(el.dataset.view);
  const action = el.dataset.action;
  if (action === 'collapse') $('#shell').classList.toggle('is-collapsed');
  if (action === 'dialog') openDialog();
  if (action === 'back' && history.length) {
    future.push(current);
    go(history.pop(), false);
  }
  if (action === 'forward' && future.length) {
    history.push(current);
    go(future.pop(), false);
  }
});

render();
