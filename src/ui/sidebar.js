// The left sidebar: the frame every page sits in, as Motion draws it.
//
// New and the thing happening now at the top, then search, the places —
// today's agenda, the calendar, all tasks, the shelf, people — then the other
// views of the open plan, Favorites (pinned projects), and the workspaces as a
// tree of their projects. It replaces the row of view tabs; the menu bar stays
// above the page for what a desktop app keeps in menus.
//
// The shelf is read asynchronously, so the tree draws from a cache that is
// refreshed when plans or workspaces change, and on a timer for the "now" row.

import { el, clear } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { formatClock } from '../model/agenda.js';
import { toDay, today, formatDate, WEEKDAY_NAMES, weekday } from '../model/calendar.js';
import { showMenu, promptText } from './dialog.js';
import { currentLayout, lateness } from './calendar.js';

const PLACES = [
  { view: 'today', icon: '☀', label: 'Agenda' },
  { view: 'calendar', icon: '▦', label: 'Calendar' },
  { view: 'alltasks', icon: '≣', label: 'Projects & Tasks' },
  { view: 'projects', icon: '▢', label: 'Projects' },
  { view: 'people', icon: '☺', label: 'People' },
];
const PLAN_VIEWS = [
  { view: 'gantt', icon: '▤', label: 'Gantt' },
  { view: 'kanban', icon: '▥', label: 'Kanban' },
  { view: 'sheet', icon: '☰', label: 'Task sheet' },
  { view: 'priority', icon: '⚑', label: 'Priority' },
  { view: 'resources', icon: '◧', label: 'Resources' },
  { view: 'usage', icon: '▦', label: 'Usage' },
  { view: 'network', icon: '⬡', label: 'Network' },
  { view: 'schedules', icon: '◷', label: 'Schedules' },
];

const KEY = 'project-planner:sidebar';
const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } })();
const state = {
  open: saved.open !== false,
  views: saved.views !== false,
  favorites: saved.favorites !== false,
  workspaces: saved.workspaces !== false,
  expanded: new Set(saved.expanded || []),
};
const remember = () => {
  try { localStorage.setItem(KEY, JSON.stringify({ ...state, expanded: [...state.expanded] })); } catch { /* private mode */ }
};

let cache = { plans: [], spaces: [], active: '' };
let hooks = { newMenu: null, findResults: null, settings: null };

/** Re-read the shelf and the workspaces, then redraw. */
export async function refreshSidebar() {
  try {
    const sync = await import('../state/sync.js');
    const [plans, spaces] = await Promise.all([sync.listPlans().catch(() => []), sync.listWorkspaces().catch(() => [])]);
    cache = { plans: plans.filter((p) => p.ok && !p.template), spaces, active: sync.activeWorkspace() };
  } catch { /* the store is not open yet; the next refresh fills it */ }
  renderSidebar();
}

export const sidebarOpen = () => state.open;
export function toggleSidebar() { state.open = !state.open; remember(); set({}); }

let root = null;
const parts = {};

/** Build the parts that do not change; `renderSidebar` fills the rest. */
export function initSidebar(node, { newMenu, findResults, settings }) {
  root = node;
  hooks = { newMenu, findResults, settings };
  const find = el('input', {
    class: 'sc-input side-find', id: 'find', placeholder: 'Search tasks', autocomplete: 'off',
    oninput: (e) => hooks.findResults(e.target),
    onkeydown: (e) => { if (e.key === 'Escape') { e.target.value = ''; e.target.blur(); } e.stopPropagation(); },
  });
  parts.now = el('button', { class: 'side-now', id: 'running-chip' });
  parts.places = el('div', { class: 'side-list' });
  parts.views = el('div', { class: 'side-list' });
  parts.favorites = el('div', { class: 'side-list' });
  parts.workspaces = el('div', { class: 'side-list' });
  const section = (key, title, body, extra = null) => {
    const head = el('div', { class: 'side-section' },
      el('button', { class: 'side-section-toggle', onclick: () => { state[key] = !state[key]; remember(); renderSidebar(); } },
        el('span', { text: title }), el('span', { class: 'side-caret', 'data-key': key })),
      extra);
    return el('div', { class: 'side-group', 'data-key': key }, head, body);
  };
  root.append(
    el('div', { class: 'side-top' },
      el('span', { class: 'sc-brand-mark side-brand', text: 'PJ', title: 'Project Planner' }),
      el('span', { class: 'sc-spacer' }),
      el('button', { class: 'side-icon', text: '«', title: 'Hide the sidebar', onclick: toggleSidebar }),
      el('button', { class: 'side-icon', text: '⚙', title: 'Settings — sync and appearance', onclick: () => hooks.settings?.() }),
      el('button', { class: 'sc-button sc-button--primary sc-button--sm side-new', text: '＋ New', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); hooks.newMenu(r.left, r.bottom + 4); } })),
    parts.now,
    el('div', { class: 'side-search' }, find),
    el('div', { class: 'side-scroll' },
      parts.places,
      section('views', 'Views of this project', parts.views),
      section('favorites', 'Favorites', parts.favorites),
      section('workspaces', 'Workspaces', parts.workspaces,
        el('button', { class: 'side-icon side-add', text: '＋', title: 'New workspace', onclick: newWorkspace }))),
    el('div', { class: 'side-foot sc-faint small', text: 'Right-click the calendar to make an event or a task' }));
  // The "now" row moves on as the day does.
  setInterval(renderNow, 60 * 1000);
  void refreshSidebar();
}

async function newWorkspace() {
  const name = await promptText('New workspace', 'Work, personal, school — whatever the projects in it have in common.', '');
  if (!name?.trim()) return;
  const sync = await import('../state/sync.js');
  await sync.createWorkspace(name.trim());
  await refreshSidebar();
}

const item = ({ icon, label, active = false, badge = null, aside = null, onclick, title = '', cls = '', menu = null }) => el('div', {
  class: `side-item${active ? ' is-on' : ''}${cls ? ` ${cls}` : ''}`, title, onclick,
  oncontextmenu: menu ? (e) => { e.preventDefault(); menu(e.clientX, e.clientY); } : null,
},
  el('span', { class: 'side-item-icon', text: icon }),
  el('span', { class: 'side-item-label', text: label }),
  aside ? el('span', { class: 'side-item-aside', text: aside }) : null,
  badge ? el('span', { class: 'side-badge', text: String(badge) }) : null);

async function openPlanFromSidebar(id) {
  if (id !== store.project.id) {
    const { openPlan } = await import('../state/sync.js');
    if (!(await openPlan(id))) return;
  }
  set({ view: ['gantt', 'kanban', 'sheet', 'network', 'priority'].includes(store.ui.view) ? store.ui.view : 'gantt' });
  renderSidebar();
}

function planMenu(p) {
  return (x, y) => showMenu(x, y, [
    { label: 'Open', run: () => { void openPlanFromSidebar(p.id); } },
    { label: p.pinned ? 'Remove from Favorites' : 'Add to Favorites', run: async () => {
      const sync = await import('../state/sync.js');
      await sync.setPlanPinned(p.id, !p.pinned);
      await refreshSidebar();
    } },
  ]);
}

/** What is happening now — a started task, the block or meeting on now — or what is next today. */
function renderNow() {
  const node = parts.now;
  if (!node) return;
  let label = null;
  let time = null;
  let open = null;
  try {
    const layout = currentLayout();
    if (layout) {
      const d = new Date();
      const nowMin = d.getHours() * 60 + d.getMinutes();
      const day = toDay(today());
      const nameOf = (b) => layout.entries.find((e) => e.project.id === b.planId)?.project.tasks.find((t) => t.id === b.taskId)?.name;
      const live = layout.all.blocks.find((b) => b.live && b.day === day);
      const onNow = live || layout.all.blocks.find((b) => !b.worked && b.day === day && b.start <= nowMin && b.end > nowMin);
      const meeting = (layout.all.meetings || []).find((m) => m.day === day && !m.allDay && m.start <= nowMin && m.end > nowMin);
      const next = [...layout.all.blocks.filter((b) => !b.worked && b.day === day && b.start > nowMin).map((b) => ({ kind: 'block', b, start: b.start })),
        ...(layout.all.meetings || []).filter((m) => m.day === day && !m.allDay && m.start > nowMin).map((m) => ({ kind: 'meeting', m, start: m.start }))]
        .sort((a, b) => a.start - b.start)[0];
      if (onNow) { label = `${live ? '▶ ' : ''}${nameOf(onNow) || 'Task'}`; time = formatClock(onNow.start); open = () => (live ? import('./blockmenu.js').then((m) => m.stopNowDialog({ planId: live.planId, taskId: live.taskId })) : import('./blockmenu.js').then((m) => m.taskSheet({ planId: onNow.planId, taskId: onNow.taskId, block: onNow }))); }
      else if (meeting) { label = meeting.title; time = formatClock(meeting.start); open = () => import('./blockmenu.js').then((m) => m.meetingSheet(meeting)); }
      else if (next) { label = next.kind === 'block' ? (nameOf(next.b) || 'Task') : next.m.title; time = `next · ${formatClock(next.start)}`; open = () => set({ view: 'today' }); }
    }
  } catch { label = null; }
  node.hidden = !label;
  node.replaceChildren(
    el('span', { class: 'side-now-dot' }),
    el('span', { class: 'side-now-label', text: label || '' }),
    el('span', { class: 'side-now-time', text: time || '' }));
  node.onclick = open ? () => { void open(); } : null;
  node.title = label ? 'Now — click to open it' : '';
}

export function renderSidebar() {
  if (!root) return;
  document.getElementById('app')?.classList.toggle('no-side', !state.open);
  for (const c of root.querySelectorAll('.side-caret')) c.textContent = state[c.dataset.key] ? '▾' : '▸';
  for (const g of root.querySelectorAll('.side-group')) g.classList.toggle('is-closed', !state[g.dataset.key]);
  const { ui, project } = store;
  const todayDay = toDay(today());
  const dayLabel = `${WEEKDAY_NAMES[weekday(todayDay)].slice(0, 3)} ${formatDate(today(), 'day')}`;

  let late = 0;
  try { late = lateness().length; } catch { late = 0; }
  clear(parts.places);
  for (const p of PLACES) {
    parts.places.append(item({
      ...p, active: ui.view === p.view,
      badge: p.view === 'today' && late ? late : null,
      aside: p.view === 'calendar' ? dayLabel : null,
      onclick: () => set({ view: p.view }),
    }));
  }

  clear(parts.views);
  parts.views.append(el('div', { class: 'side-plan-name', title: 'The open project', text: project.name }));
  for (const v of PLAN_VIEWS) parts.views.append(item({ ...v, active: ui.view === v.view, onclick: () => set({ view: v.view }) }));

  clear(parts.favorites);
  const pinned = cache.plans.filter((p) => p.pinned && !p.archived);
  if (!pinned.length) parts.favorites.append(el('div', { class: 'side-empty', text: 'Right-click a project below to add it here.' }));
  for (const p of pinned) {
    parts.favorites.append(item({ icon: '◈', label: p.name, active: p.id === project.id, onclick: () => { void openPlanFromSidebar(p.id); }, menu: planMenu(p) }));
  }

  clear(parts.workspaces);
  const live = cache.plans.filter((p) => !p.archived);
  const groups = [...cache.spaces.map((w) => ({ id: w.id, name: w.name })), { id: '', name: 'No workspace' }];
  for (const w of groups) {
    const plans = live.filter((p) => (p.workspaceId || '') === w.id).sort((a, b) => a.name.localeCompare(b.name));
    if (!w.id && !plans.length) continue;
    const key = w.id || 'none';
    const open = state.expanded.has(key);
    const active = w.id && cache.active === w.id;
    const row = el('div', { class: `side-item side-ws${active ? ' is-on' : ''}`, title: w.id ? (active ? 'Showing only this workspace — click to show all' : 'Show only this workspace in lists') : 'Projects not filed under a workspace' },
      el('button', { class: 'side-twist', text: open ? '▾' : '▸', onclick: (e) => { e.stopPropagation(); if (open) state.expanded.delete(key); else state.expanded.add(key); remember(); renderSidebar(); } }),
      el('span', { class: 'side-item-icon', text: '◫' }),
      el('span', { class: 'side-item-label', text: w.name }),
      el('span', { class: 'side-count', text: String(plans.length) }));
    if (w.id) {
      row.onclick = async () => {
        const sync = await import('../state/sync.js');
        sync.setActiveWorkspace(active ? '' : w.id);
        const { refreshWorkspaceLabel } = await import('./toolbar.js');
        await refreshWorkspaceLabel();
        await refreshSidebar();
        set({});
      };
    } else row.onclick = () => { if (open) state.expanded.delete(key); else state.expanded.add(key); remember(); renderSidebar(); };
    parts.workspaces.append(row);
    if (open) {
      for (const p of plans) {
        parts.workspaces.append(item({ icon: p.pinned ? '◈' : '▢', label: p.name, cls: 'side-child', active: p.id === project.id,
          title: `${p.tasks} tasks`, onclick: () => { void openPlanFromSidebar(p.id); }, menu: planMenu(p) }));
      }
      if (!plans.length) parts.workspaces.append(el('div', { class: 'side-empty side-child', text: 'No projects yet' }));
    }
  }
  renderNow();
}
