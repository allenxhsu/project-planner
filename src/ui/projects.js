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
import { listPlans, refreshPlans, openPlan, deletePlan, duplicatePlan, setPlanTemplate, setPlanArchived, setPlanWorkspace, setPlanPinned, listWorkspaces, activeWorkspace, syncConfigured, syncStatus } from '../state/sync.js';
import { formatDate } from '../model/calendar.js';
import { showMenu, confirmDialog, promptText } from './dialog.js';
import { newProjectWizard } from './newproject.js';
import { refreshSidebar } from './sidebar.js';

/** The last list read from the shelf. Rendering is synchronous; reading is not. */
let plans = [];
let loading = true;
let loaded = false;
/** Whether the archive is open. The gallery is about work in hand. */
let showArchive = false;

/** Re-read the shelf and redraw. `pull` also asks the server first. */
/** The workspaces a plan can be filed under, read alongside the shelf. */
let spaces = [];

export async function reloadPlans({ pull = false } = {}) {
  loading = true;
  set({});
  try {
    plans = pull ? await refreshPlans() : await listPlans();
    spaces = await listWorkspaces();
  } catch {
    plans = [];
  }
  loading = false;
  loaded = true;
  set({});
  void refreshSidebar();
}

/** Everything you can do to a plan, from a card or from a row. */
function cardMenu(p, x, y) {
  const open = async () => {
    if (p.id === store.project.id) { set({ view: 'gantt' }); return; }
    if (await openPlan(p.id)) set({ view: 'gantt' });
  };
  showMenu(x, y, [
      { label: 'Open', run: () => { void open(); } },
      '-',
      { label: 'Duplicate', run: async () => {
        const name = await promptText('Duplicate this plan', 'What is the copy called?', `${p.name} (copy)`);
        if (!name) return;
        if (await duplicatePlan(p.id, { name })) { set({ view: 'gantt' }); void reloadPlans(); }
      } },
      { label: 'New plan from this as a template', run: async () => {
        const name = await promptText('Use this plan as a template',
          'The copy keeps the tasks, links, resources and stages, and starts clean: no progress, no logged hours, no pinned dates or deadlines.',
          `${p.name} (template)`);
        if (!name) return;
        if (await duplicatePlan(p.id, { asTemplate: true, name })) { set({ view: 'gantt' }); void reloadPlans(); }
      } },
      '-',
      { label: p.pinned ? 'Unpin from the top' : 'Pin to the top', run: async () => { await setPlanPinned(p.id, !p.pinned); void reloadPlans(); } },
      '-',
      ...(spaces.length ? [
        { note: 'Workspace' },
        { label: 'Unfiled', checked: !p.workspaceId, run: async () => { await setPlanWorkspace(p.id, null); void reloadPlans(); } },
        ...spaces.map((w) => ({ label: w.name, checked: p.workspaceId === w.id, run: async () => { await setPlanWorkspace(p.id, w.id); void reloadPlans(); } })),
        '-',
      ] : []),
      { label: p.archived ? 'Bring back from the archive' : 'Archive', 
        run: async () => { await setPlanArchived(p.id, !p.archived); void reloadPlans(); } },
      { label: p.template ? 'Not a template — put it back on the calendar' : 'Mark as a template', 
        run: async () => { await setPlanTemplate(p.id, !p.template); void reloadPlans(); } },
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
}

function card(p) {
  const open = () => { void openThis(); };
  const openThis = async () => {
    if (p.id === store.project.id) { set({ view: 'gantt' }); return; }
    if (await openPlan(p.id)) set({ view: 'gantt' });
  };
  const isOpen = p.id === store.project.id;
  const menu = (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); cardMenu(p, r.left - 170, r.bottom + 4); };

  return el('article', { class: `plan-card sc-card sc-brackets sc-brackets--hover${isOpen ? ' is-open' : ''}${p.archived ? ' is-archived' : ''}`, onclick: open, title: `Last saved ${formatDate(new Date(p.updatedAt).toISOString().slice(0, 10), 'long')} on ${p.origin || 'this device'}` },
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
      p.pinned ? el('span', { class: 'sc-pill', title: 'Pinned to the top', text: '★' }) : null,
      p.template ? el('span', { class: 'sc-pill', title: 'A pattern to copy — its tasks stay off the calendar', text: 'Template' }) : null,
      p.archived ? el('span', { class: 'sc-pill', title: p.archivedAt ? `Archived ${formatDate(p.archivedAt, 'long')}` : 'Archived', text: 'Archived' }) : null,
      !activeWorkspace() && p.workspaceId ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-text-3)' }, title: 'The workspace this project is filed under', text: spaces.find((w) => w.id === p.workspaceId)?.name || 'Filed' }) : null,
      isOpen ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-app)' }, text: 'Open' }) : null));
}

/** One plan as a row: the same facts as a card, in a line you can scan. */
function row(p, spaces) {
  const isOpen = p.id === store.project.id;
  const open = async () => {
    if (isOpen) { set({ view: 'gantt' }); return; }
    if (await openPlan(p.id)) set({ view: 'gantt' });
  };
  return el('tr', {
    class: `plan-row${isOpen ? ' is-open' : ''}${p.archived ? ' is-archived' : ''}`,
    onclick: () => { void open(); },
    oncontextmenu: (e) => { e.preventDefault(); cardMenu(p, e.clientX, e.clientY); },
  },
    el('td', { class: 'plan-row-pin' }, el('button', {
      class: `sc-button sc-button--ghost sc-button--icon sc-button--sm${p.pinned ? ' is-on' : ''}`,
      title: p.pinned ? 'Unpin from the top' : 'Pin to the top', text: p.pinned ? '★' : '☆',
      onclick: async (e) => { e.stopPropagation(); await setPlanPinned(p.id, !p.pinned); void reloadPlans(); },
    })),
    el('td', {}, el('span', { class: 'cell-text plan-row-name', text: p.name }),
      p.template ? el('span', { class: 'sc-pill', text: 'Template' }) : null,
      p.archived ? el('span', { class: 'sc-pill', text: 'Archived' }) : null,
      isOpen ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-app)' }, text: 'Open' }) : null),
    el('td', { class: 'sc-faint', text: !activeWorkspace() && p.workspaceId ? (spaces.find((w) => w.id === p.workspaceId)?.name || '') : '' }),
    el('td', { class: 'sc-mono num', text: p.ok ? formatDate(p.startIso, 'day') : '—' }),
    el('td', { class: 'sc-mono num', text: p.ok && p.finishIso ? formatDate(p.finishIso, 'day') : '—' }),
    el('td', { class: 'num', text: String(p.tasks ?? 0) }),
    el('td', { class: 'num' }, p.critical ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-danger)' }, text: String(p.critical) }) : null),
    el('td', { class: 'num' }, el('span', { class: 'sc-meter plan-row-meter' }, el('span', { style: { '--value': `${p.percent || 0}%` } }))),
    el('td', { class: 'num', text: `${p.percent || 0}%` }),
    el('td', { class: 'plan-row-menu' }, el('button', {
      class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '⋮', title: 'Actions',
      onclick: (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); cardMenu(p, r.left - 200, r.bottom + 4); },
    })));
}

function listOf(plans, spaces) {
  const table = el('table', { class: 'grid plan-list' });
  table.append(el('thead', {}, el('tr', {},
    el('th', { text: '' }), el('th', { text: 'Project' }), el('th', { text: 'Workspace' }),
    el('th', { class: 'num', text: 'Start' }), el('th', { class: 'num', text: 'Finish' }),
    el('th', { class: 'num', text: 'Tasks' }), el('th', { class: 'num', text: 'Critical' }),
    el('th', { class: 'num', text: 'Progress' }), el('th', { class: 'num', text: '%' }), el('th', { text: '' }))));
  const body = el('tbody');
  for (const p of plans) body.append(row(p, spaces));
  table.append(body);
  return table;
}

export function renderProjects(root) {
  clear(root);
  if (!loaded && !loading) void reloadPlans();
  const pane = el('div', { class: 'projects-pane' });
  root.append(pane);

  // A workspace is what is in front: work, personal, school. An unfiled plan
  // belongs to none of them and so shows up wherever you are.
  const active = activeWorkspace();
  const here = plans.filter((p) => !active || (p.workspaceId || null) === active || !p.workspaceId);

  pane.append(el('div', { class: 'projects-head people-head' },
    el('div', { class: 'people-head-text' },
      el('div', { class: 'sc-display', text: 'Projects' }),
      el('span', { class: 'sc-muted small', text: active
      ? `The projects in this workspace, and any that are not filed under one. ${spaces.find((w) => w.id === active)?.name || ''}`.trim()
        : (syncConfigured() ? 'Every plan on this device and on every device you sync with.' : 'Every plan on this device. Turn on Sync… to keep a copy online and see plans from your other devices.') })),
    el('div', { class: 'people-head-actions' },
      el('button', { class: `sc-button sc-button--sm${store.ui.projectsLayout !== 'list' ? ' is-on' : ''}`, text: 'Cards', title: 'One card per project', onclick: () => set({ projectsLayout: 'cards' }) }),
      el('button', { class: `sc-button sc-button--sm${store.ui.projectsLayout === 'list' ? ' is-on' : ''}`, text: 'List', title: 'One row per project', onclick: () => set({ projectsLayout: 'list' }) }),
      el('button', { class: 'sc-button sc-button--primary sc-button--sm', text: '+ Project', title: 'Start a project — from scratch or from a template', onclick: () => { void newProjectWizard(); } }))));

  const live = here.filter((p) => !p.archived);
  const archived = here.filter((p) => p.archived);

  const asList = store.ui.projectsLayout === 'list';
  const grid = asList ? el('div', { class: 'plan-listing' }) : el('div', { class: 'plan-grid' });
  if (!asList) grid.append(el('button', {
    class: 'plan-card plan-new sc-card sc-brackets',
    // A plan started while a workspace is in front belongs to that workspace.
    onclick: () => { void newProjectWizard(); },
  }, el('div', { class: 'plan-new-mark', text: '+' }), el('div', { text: 'New project' })));
  if (!live.length && !loading && !asList) {
    grid.append(el('button', { class: 'plan-card plan-new sc-card sc-brackets', onclick: () => { loadProject(sampleProject()); set({ view: 'gantt' }); void reloadPlans(); } },
      el('div', { class: 'plan-new-mark', text: '◈' }), el('div', { text: 'Open the sample plan' })));
  }
  if (asList) grid.append(listOf(live, spaces));
  else for (const p of live) grid.append(card(p));
  pane.append(grid);

  // The archive is kept, not hidden: it is one click away and says how much is in it.
  if (archived.length) {
    pane.append(el('button', {
      class: 'sc-button sc-button--ghost sc-button--sm projects-archive-toggle',
      text: `${showArchive ? '▾' : '▸'} Archive (${archived.length})`,
      title: 'Finished or shelved plans, kept in full and out of the way',
      onclick: () => { showArchive = !showArchive; set({}); },
    }));
    if (showArchive) {
      if (asList) pane.append(listOf(archived, spaces));
      else {
        const old = el('div', { class: 'plan-grid' });
        for (const p of archived) old.append(card(p));
        pane.append(old);
      }
    }
  }

  if (loading) pane.append(el('p', { class: 'empty', text: 'Reading the shelf…' }));
  else if (!live.length && !archived.length) pane.append(el('p', { class: 'empty', text: 'Nothing on the shelf yet. A plan lands here as soon as you edit it.' }));
  else pane.append(el('p', { class: 'sc-faint small projects-note', text: `${live.length} ${live.length === 1 ? 'plan' : 'plans'}${archived.length ? `, ${archived.length} archived` : ''}${syncConfigured() && syncStatus().lastSyncAt ? `, last sync ${new Date(syncStatus().lastSyncAt).toLocaleTimeString()}` : ''}` }));
}
