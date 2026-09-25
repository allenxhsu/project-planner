// The Projects screen: every plan on the shelf, as a card.
//
// The shelf is the sync record store (state/sync.js), so this lists what this
// device has opened *and* what any other device has — a plan made on the Mac
// shows up in the browser after a sync, and the other way round. It works with
// sync switched off too; then the shelf is simply this device's own plans.

import { el, clear, formatMoney } from '../util.js';
import { store, set, loadProject } from '../state/store.js';
import { createProject } from '../model/model.js';
import { sampleProject } from '../model/sample.js';
import { listPlans, refreshPlans, openPlan, deletePlan, syncConfigured, syncStatus } from '../state/sync.js';
import { formatDate } from '../model/calendar.js';
import { showMenu, confirmDialog } from './dialog.js';

/** The last list read from the shelf. Rendering is synchronous; reading is not. */
let plans = [];
let loading = true;
let loaded = false;

/** Re-read the shelf and redraw. `pull` also asks the server first. */
export async function reloadPlans({ pull = false } = {}) {
  loading = true;
  set({});
  try {
    plans = pull ? await refreshPlans() : await listPlans();
  } catch {
    plans = [];
  }
  loading = false;
  loaded = true;
  set({});
}

function card(p) {
  const open = () => { void openThis(); };
  const openThis = async () => {
    if (p.id === store.project.id) { set({ view: 'gantt' }); return; }
    if (await openPlan(p.id)) set({ view: 'gantt' });
  };
  const isOpen = p.id === store.project.id;
  const menu = (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.left - 150, r.bottom + 4, [
      { label: 'Open', run: open },
      '-',
      { label: 'Delete from the shelf', danger: true, run: async () => {
        const yes = await confirmDialog('Delete this plan?',
          `“${p.name}” goes from this device and, on the next sync, from every other one. A file you saved with File ▸ Save is not touched.`);
        if (!yes) return;
        await deletePlan(p.id);
        if (p.id === store.project.id) loadProject(createProject());
        void reloadPlans();
      } },
    ]);
  };

  return el('article', { class: `plan-card sc-card sc-brackets sc-brackets--hover${isOpen ? ' is-open' : ''}`, onclick: open, title: `Last saved ${formatDate(new Date(p.updatedAt).toISOString().slice(0, 10), 'long')} on ${p.origin || 'this device'}` },
    el('div', { class: 'plan-head' },
      el('h3', { class: 'plan-name', text: p.name }),
      el('button', { class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '⋮', title: 'Actions', onclick: menu })),
    p.ok
      ? el('div', { class: 'plan-dates sc-mono' }, `${formatDate(p.startIso, 'day')} → ${p.finishIso ? formatDate(p.finishIso, 'day') : '—'}`)
      : el('div', { class: 'plan-dates sc-mono warn', text: 'This plan could not be read' }),
    el('div', { class: 'plan-meter sc-meter' }, el('span', { style: { '--value': `${p.percent || 0}%` } })),
    el('div', { class: 'plan-foot' },
      el('span', { class: 'plan-count', text: `${p.tasks ?? 0} ${p.tasks === 1 ? 'task' : 'tasks'}` }),
      p.resources ? el('span', { class: 'sc-faint', text: `${p.resources} ${p.resources === 1 ? 'resource' : 'resources'}` }) : null,
      el('span', { class: 'sc-spacer' }),
      p.critical ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-danger)' }, text: `${p.critical} critical` }) : null,
      el('span', { class: 'sc-pill', text: `${p.percent || 0}%` }),
      isOpen ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-app)' }, text: 'Open' }) : null));
}

export function renderProjects(root) {
  clear(root);
  if (!loaded && !loading) void reloadPlans();
  const pane = el('div', { class: 'projects-pane' });
  root.append(pane);

  pane.append(el('div', { class: 'projects-head' },
    el('div', { class: 'sc-display', text: 'Projects' }),
    el('span', { class: 'sc-muted small', text: syncConfigured() ? 'Every plan on this device and on every device you sync with.' : 'Every plan on this device. Turn on Sync… to keep a copy online and see plans from your other devices.' })));

  const grid = el('div', { class: 'plan-grid' });
  grid.append(el('button', {
    class: 'plan-card plan-new sc-card sc-brackets', onclick: () => { loadProject(createProject()); set({ view: 'gantt' }); void reloadPlans(); },
  }, el('div', { class: 'plan-new-mark', text: '+' }), el('div', { text: 'New project' })));
  if (!plans.length && !loading) {
    grid.append(el('button', { class: 'plan-card plan-new sc-card sc-brackets', onclick: () => { loadProject(sampleProject()); set({ view: 'gantt' }); void reloadPlans(); } },
      el('div', { class: 'plan-new-mark', text: '◈' }), el('div', { text: 'Open the sample plan' })));
  }
  for (const p of plans) grid.append(card(p));
  pane.append(grid);

  if (loading) pane.append(el('p', { class: 'empty', text: 'Reading the shelf…' }));
  else if (!plans.length) pane.append(el('p', { class: 'empty', text: 'Nothing on the shelf yet. A plan lands here as soon as you edit it.' }));
  else pane.append(el('p', { class: 'sc-faint small projects-note', text: `${plans.length} ${plans.length === 1 ? 'plan' : 'plans'}${syncConfigured() && syncStatus().lastSyncAt ? `, last sync ${new Date(syncStatus().lastSyncAt).toLocaleTimeString()}` : ''}` }));
}
