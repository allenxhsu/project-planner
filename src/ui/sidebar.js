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
import { icon as ic, projectColour } from './icons.js';

const PLACES = [
  { view: 'today', icon: 'agenda', label: 'Agenda' },
  { view: 'calendar', icon: 'calendar', label: 'Calendar' },
  { view: 'alltasks', icon: 'project', label: 'Projects & Tasks' },
  { view: 'projects', icon: 'folder', label: 'Projects' },
  { view: 'people', icon: 'people', label: 'People' },
];
const PLAN_VIEWS = [
  { view: 'list', icon: 'list', label: 'Task list' },
  { view: 'gantt', icon: 'timeline', label: 'Gantt' },
  { view: 'kanban', icon: 'kanban', label: 'Kanban' },
  { view: 'sheet', icon: 'sheet', label: 'Task sheet' },
  { view: 'priority', icon: 'priority', label: 'Priority' },
  { view: 'resources', icon: 'resources', label: 'Resources' },
  { view: 'usage', icon: 'usage', label: 'Usage' },
  { view: 'network', icon: 'network', label: 'Network' },
  { view: 'schedules', icon: 'clock', label: 'Schedules' },
];

const KEY = 'project-planner:sidebar';
const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } })();
const state = {
  open: saved.open !== false,
  views: saved.views !== false,
  favorites: saved.favorites !== false,
  workspaces: saved.workspaces !== false,
  expanded: new Set(saved.expanded || []),
  width: Number.isFinite(saved.width) ? saved.width : 224,
};
/** How wide the sidebar may be dragged. */
const SIDE_MIN = 180;
const SIDE_MAX = 400;
const applyWidth = () => document.getElementById('app')?.style.setProperty('--side-w', `${state.width}px`);
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
/** A handle on the sidebar's right edge: drag to resize, double-click for the default width. */
function resizeHandle() {
  const handle = el('div', { class: 'side-resize', title: 'Drag to resize · double-click to reset' });
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('is-on');
    document.body.classList.add('is-resizing');
    const left = root.getBoundingClientRect().left;
    const move = (ev) => { state.width = Math.round(Math.max(SIDE_MIN, Math.min(SIDE_MAX, ev.clientX - left))); applyWidth(); };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.classList.remove('is-on');
      document.body.classList.remove('is-resizing');
      remember();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('dblclick', () => { state.width = 224; applyWidth(); remember(); });
  return handle;
}
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
    // What is left of the sidebar when it is hidden: a way back.
    el('button', { class: 'side-rail', text: '»', title: 'Show the sidebar', onclick: toggleSidebar }),
    el('div', { class: 'side-top' },
      el('span', { class: 'sc-brand-mark side-brand', text: 'PJ', title: 'Project Planner' }),
      el('span', { class: 'sc-spacer' }),
      el('button', { class: 'side-icon', id: 'btn-undo', text: '↶', title: 'Undo (⌘Z)', onclick: () => { void import('../state/store.js').then((m) => m.undo()); } }),
      el('button', { class: 'side-icon', id: 'btn-redo', text: '↷', title: 'Redo (⇧⌘Z)', onclick: () => { void import('../state/store.js').then((m) => m.redo()); } }),
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
    el('div', { class: 'side-foot sc-faint small', text: 'Right-click the calendar to make an event or a task' }),
    resizeHandle());
  applyWidth();
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

const item = ({ icon, label, active = false, badge = null, aside = null, onclick, title = '', cls = '', menu = null, open = null, plus = null }) => el('div', {
  class: `side-item${active ? ' is-on' : ''}${cls ? ` ${cls}` : ''}`, title, onclick,
  ondblclick: open ? (e) => { e.preventDefault(); open(); } : null,
  oncontextmenu: menu ? (e) => { e.preventDefault(); menu(e.clientX, e.clientY); } : null,
},
  typeof icon === 'string' ? el('span', { class: 'side-item-icon', text: icon }) : el('span', { class: 'side-item-icon' }, icon),
  el('span', { class: 'side-item-label', text: label }),
  aside ? el('span', { class: 'side-item-aside', text: aside }) : null,
  badge ? el('span', { class: 'side-badge', text: String(badge) }) : null,
  // A project's own buttons, shown on hover as in Motion: its menu, and a new task in it.
  open && menu ? el('span', { class: 'side-hover' },
    el('button', { class: 'side-mini', text: '⋯', title: 'Project menu', onclick: (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); menu(r.left, r.bottom + 4); } }),
    plus ? el('button', { class: 'side-mini', text: '＋', title: 'A new task in this project', onclick: (e) => { e.stopPropagation(); plus(); } }) : null) : null);

/** A project, clicked: it becomes the plan the views show; the view stays as it is. */
async function selectPlanFromSidebar(id) {
  if (id !== store.project.id) {
    const { openPlan } = await import('../state/sync.js');
    if (!(await openPlan(id))) return;
  }
  renderSidebar();
}

/** A project's ＋: the project becomes the open plan, and the new-task panel opens on it. */
async function newTaskIn(id) {
  await selectPlanFromSidebar(id);
  const { newTaskPanel } = await import('./taskpanel.js');
  await newTaskPanel();
}

/** A new folder in a workspace, opened so projects can be dragged into it. */
async function newFolder(w) {
  const name = await promptText('New folder', `A folder in ${w.name}. Drag projects onto it to file them.`, '');
  if (!name?.trim()) return;
  const sync = await import('../state/sync.js');
  const folder = await sync.createFolder(w.id, name);
  if (folder) { state.expanded.add(w.id); state.expanded.add(`folder:${folder.id}`); remember(); }
  await refreshSidebar();
}

/** A project's window (its ↗ button, a double-click, or Open project), over a view of it. */
async function openPlanFromSidebar(id) {
  if (!['list', 'gantt', 'kanban', 'sheet', 'network', 'priority', 'alltasks'].includes(store.ui.view)) set({ view: 'gantt' });
  const { projectSheet } = await import('./projectsheet.js');
  await projectSheet({ planId: id });
  renderSidebar();
}

const ORDER_KEY = 'project-planner:sidebar-order';
const readOrder = () => { try { return JSON.parse(localStorage.getItem(ORDER_KEY) || '[]'); } catch { return []; } };
const writeOrder = (ids) => { try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)); } catch { /* private mode */ } };
/**
 * Projects in the order they were put in by hand (dragged, or moved up and
 * down — kept in the plan, so every device agrees), then by name.
 */
function ordered(plans) {
  const order = readOrder();          // this device's order from before it was kept in the plans
  const local = (id) => { const i = order.indexOf(id); return i < 0 ? Infinity : i; };
  const at = (p) => (Number.isFinite(p.sortOrder) ? p.sortOrder : Infinity);
  return [...plans].sort((a, b) => at(a) - at(b) || local(a.id) - local(b.id) || a.name.localeCompare(b.name));
}
/** Write a place's order (and move a plan into it), then redraw. */
async function arrange(ids, workspaceId, folderId) {
  const sync = await import('../state/sync.js');
  await sync.arrangePlans(ids, workspaceId, folderId);
  await refreshSidebar();
}
function move(p, siblings, by) {
  const list = ordered(siblings).map((x) => x.id);
  const i = list.indexOf(p.id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  void arrange(list, p.workspaceId, p.folderId);
}

// ------------------------------------------------ dragging projects and folders
//
// A project dragged onto another goes above or below it, into that one's
// workspace and folder; onto a folder, into the folder; onto a workspace, into
// the workspace outside any folder. A folder dragged onto another folder of
// the same workspace goes above or below it.

let drag = null;                 // { kind: 'plan' | 'folder', id, workspaceId }
const DROP = ['is-drop-before', 'is-drop-after', 'is-drop-into'];
const clearDrop = () => { for (const n of root?.querySelectorAll('.is-drop-before, .is-drop-after, .is-drop-into') || []) n.classList.remove(...DROP); };
const half = (e) => { const r = e.currentTarget.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 ? 'before' : 'after'; };

function draggable(node, what) {
  node.draggable = true;
  node.addEventListener('dragstart', (e) => {
    drag = what;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', what.id);
    node.classList.add('is-dragging');
  });
  node.addEventListener('dragend', () => { drag = null; node.classList.remove('is-dragging'); clearDrop(); });
}
/** `where(e, what)` says 'before', 'after', 'into' or null (not here); `drop(where, what)` does it. */
function dropTarget(node, where, drop) {
  node.addEventListener('dragover', (e) => {
    const w = drag && where(e, drag);
    if (!w) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!node.classList.contains(`is-drop-${w}`)) { clearDrop(); node.classList.add(`is-drop-${w}`); }
  });
  node.addEventListener('dragleave', (e) => { if (!node.contains(e.relatedTarget)) node.classList.remove(...DROP); });
  node.addEventListener('drop', (e) => {
    const what = drag;
    const w = what && where(e, what);
    if (!w) return;
    e.preventDefault();
    clearDrop();
    drag = null;
    void drop(w, what);
  });
}

const HUE_GRID = [0, 30, 55, 90, 150, 185, 205, 240, 280, 320, 10, 45, 75, 120, 170, 195, 220, 260, 300, 340];

/**
 * A project's right-click menu, as Motion's sidebar has it: its colour, then
 * open, complete or cancel it, copy a link, favourite it, move it to another
 * workspace or up and down the list, and delete it.
 */
function planMenu(p, siblings = []) {
  return async (x, y) => {
    const sync = await import('../state/sync.js');
    const spaces = cache.spaces;
    const status = async (value) => {
      await sync.patchPlan(p.id, (project) => {
        project.status = value;
        project.archived = value === 'Completed' || value === 'Cancelled';
        project.archivedAt = project.archived ? new Date().toISOString().slice(0, 10) : null;
        if (value === 'Cancelled') for (const t of project.tasks) if (t.calendar?.show) t.calendar = { ...t.calendar, show: false };
      }, value === 'Completed' ? 'Complete the project' : 'Cancel the project');
      await refreshSidebar();
      set({});
    };
    showMenu(x, y, [
      { panel: null, note: 'Colour' },
      { label: 'colours', panel: null, render: true },
      '-',
      { icon: '↗', label: 'Open project', run: () => { void openPlanFromSidebar(p.id); } },
      { icon: '✓', label: 'Complete project', run: () => { void status('Completed'); } },
      { icon: '⊘', label: 'Cancel project', run: () => { void status('Cancelled'); } },
      { icon: '⧉', label: 'Copy link', run: () => { const url = `${location.origin}${location.pathname}#plan=${encodeURIComponent(p.id)}`; navigator.clipboard?.writeText(url).then(() => act.hint('Link copied.'), () => act.hint(url)); } },
      { icon: p.pinned ? '☆' : '★', label: p.pinned ? 'Remove from Favorites' : 'Add to Favorites', run: async () => { await sync.setPlanPinned(p.id, !p.pinned); await refreshSidebar(); } },
      { icon: '✦', label: 'Save as template', run: async () => {
        const back = store.project.id;
        const copy = await sync.duplicatePlan(p.id, { asTemplate: true, name: `${p.name} (template)` });
        if (copy) await sync.openPlan(back);
        act.hint(copy ? `Saved “${p.name}” as a template: New project… offers it.` : 'The template could not be made.');
      } },
      { icon: '↪', label: 'Move to', submenu: [
        ...spaces.flatMap((w) => [
          { label: `${(p.workspaceId || '') === w.id && !p.folderId ? '✓ ' : ''}${w.name}`, run: async () => { await sync.setPlanWorkspace(p.id, w.id); await refreshSidebar(); set({}); } },
          ...(Array.isArray(w.folders) ? w.folders : []).map((f) => ({ label: `${p.folderId === f.id ? '✓ ' : ''}   ▭ ${f.name}`, run: async () => { await sync.setPlanFolder(p.id, w.id, f.id); await refreshSidebar(); set({}); } })),
        ]),
        { label: `${p.workspaceId ? '' : '✓ '}No workspace`, run: async () => { await sync.setPlanWorkspace(p.id, null); await refreshSidebar(); set({}); } },
      ] },
      '-',
      { icon: '↑', label: 'Move up', run: () => move(p, siblings, -1) },
      { icon: '↓', label: 'Move down', run: () => move(p, siblings, 1) },
      '-',
      { icon: '🗑', label: 'Delete', danger: true, run: async () => {
        const { confirmDialog } = await import('./dialog.js');
        if (!(await confirmDialog(`Delete “${p.name}”?`, 'It goes from this device and, on the next sync, from every other one. A file you saved with File ▸ Save As is not touched.'))) return;
        await sync.deletePlan(p.id);
        await refreshSidebar();
        set({});
      } },
    ].filter((it) => !it.render && !(it.note === 'Colour')));
    // The colour grid sits above the items, as in Motion.
    const menu = document.querySelector('.pop-menu:last-of-type');
    if (menu) {
      const grid = el('div', { class: 'side-colours' }, ...[null, ...HUE_GRID].map((h) => el('button', {
        class: `side-colour${(p.colour ?? null) === h ? ' is-on' : ''}`, title: h === null ? 'Automatic' : `Hue ${h}`,
        style: { background: h === null ? 'var(--sc-text-3)' : `hsl(${h} 65% 55%)` }, text: h === null ? 'A' : '',
        onclick: async () => {
          const { closeMenu } = await import('./dialog.js');
          closeMenu();
          await sync.patchPlan(p.id, (project) => { project.colour = h; }, 'Project colour');
          await refreshSidebar();
          set({});
        },
      })));
      menu.prepend(grid, el('div', { class: 'sc-menu-sep' }));
      // Taller now: keep it on the screen.
      const r = menu.getBoundingClientRect();
      if (r.bottom > window.innerHeight - 4) menu.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`;
    }
  };
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
      ...p, icon: ic(p.icon), active: ui.view === p.view || (p.view === 'alltasks' && ui.view === 'team'),
      badge: p.view === 'today' && late ? late : null,
      aside: p.view === 'calendar' ? dayLabel : null,
      onclick: () => set({ view: p.view }),
    }));
  }

  clear(parts.views);
  parts.views.append(el('button', { class: 'side-plan-name', title: 'Open the project — stages, dates and its tasks',
    onclick: () => { void import('./projectsheet.js').then((m) => m.projectSheet()); } }, ic('project', projectColour(project.colour)), el('span', { text: project.name })));
  for (const v of PLAN_VIEWS) parts.views.append(item({ ...v, icon: ic(v.icon), active: ui.view === v.view, onclick: () => set({ view: v.view }) }));

  clear(parts.favorites);
  const pinned = ordered(cache.plans.filter((p) => p.pinned && !p.archived));
  if (!pinned.length) parts.favorites.append(el('div', { class: 'side-empty', text: 'Right-click a project below to add it here.' }));
  for (const p of pinned) {
    parts.favorites.append(item({ icon: ic('project', projectColour(p.colour)), label: p.name, active: p.id === project.id, onclick: () => { void selectPlanFromSidebar(p.id); }, open: () => { void openPlanFromSidebar(p.id); }, plus: () => { void newTaskIn(p.id); }, menu: planMenu(p, pinned) }));
  }

  clear(parts.workspaces);
  const live = cache.plans.filter((p) => !p.archived);
  const groups = [...cache.spaces.map((w) => ({ id: w.id, name: w.name, folders: Array.isArray(w.folders) ? w.folders.filter((f) => f?.id && f.name) : [] })), { id: '', name: 'No workspace', folders: [] }];
  const hoverButtons = (...buttons) => el('span', { class: 'side-hover' }, ...buttons);
  const iconButton = (text, title, run) => el('button', { class: 'side-mini', text, title, onclick: (e) => { e.stopPropagation(); run(e); } });
  const toggle = (key) => { if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key); remember(); renderSidebar(); };

  /** A project row, draggable, with the places it can be dropped around it. */
  const planRow = (p, siblings, wsId, folderId, cls) => {
    const row = item({ icon: ic('project', projectColour(p.colour)), label: p.name, cls, active: p.id === project.id,
      title: `${p.tasks} tasks — double-click to open; drag to move`, onclick: () => { void selectPlanFromSidebar(p.id); },
      open: () => { void openPlanFromSidebar(p.id); }, plus: () => { void newTaskIn(p.id); }, menu: planMenu(p, siblings) });
    row.prepend(el('span', { class: 'side-grip', text: '⠿' }));
    draggable(row, { kind: 'plan', id: p.id, workspaceId: wsId });
    dropTarget(row, (e, what) => (what.kind === 'plan' && what.id !== p.id ? half(e) : null), (side, what) => {
      const ids = ordered(siblings).map((x) => x.id).filter((id) => id !== what.id);
      let i = ids.indexOf(p.id);
      if (side === 'after') i++;
      ids.splice(i, 0, what.id);
      return arrange(ids, wsId || null, folderId);
    });
    return row;
  };

  for (const w of groups) {
    const plansHere = live.filter((p) => (p.workspaceId || '') === w.id);
    if (!w.id && !plansHere.length) continue;
    const folderIds = new Set(w.folders.map((f) => f.id));
    const loose = ordered(plansHere.filter((p) => !p.folderId || !folderIds.has(p.folderId)));
    const key = w.id || 'none';
    const open = state.expanded.has(key);
    const active = w.id && cache.active === w.id;
    const wsMenu = (x, y) => showMenu(x, y, [
      { icon: '▢', label: 'New project…', run: () => { void import('./newproject.js').then((m) => m.newProjectWizard({ workspaceId: w.id || null })); } },
      w.id ? { icon: '▭', label: 'New folder…', run: () => { void newFolder(w); } } : null,
      w.id ? '-' : null,
      w.id ? { icon: '✎', label: 'Rename workspace…', run: async () => {
        const name = await promptText('Rename the workspace', '', w.name);
        if (!name?.trim()) return;
        const sync = await import('../state/sync.js');
        await sync.renameWorkspace(w.id, name);
        await refreshSidebar();
      } } : null,
    ]);
    const row = el('div', { class: `side-item side-ws${active ? ' is-on' : ''}`, title: w.id ? (active ? 'Showing only this workspace — click to show all' : 'Show only this workspace in lists') : 'Projects not filed under a workspace',
      oncontextmenu: (e) => { e.preventDefault(); wsMenu(e.clientX, e.clientY); } },
      el('button', { class: 'side-twist', text: open ? '▾' : '▸', onclick: (e) => { e.stopPropagation(); toggle(key); } }),
      el('span', { class: 'side-item-icon' }, ic('workspace')),
      el('span', { class: 'side-item-label', text: w.name }),
      el('span', { class: 'side-count', text: String(plansHere.length) }),
      hoverButtons(iconButton('⋯', 'Workspace menu', (e) => { const r = e.currentTarget.getBoundingClientRect(); wsMenu(r.left, r.bottom + 4); }),
        iconButton('＋', w.id ? 'New project or folder' : 'New project', (e) => { const r = e.currentTarget.getBoundingClientRect(); wsMenu(r.left, r.bottom + 4); })));
    if (w.id) {
      row.onclick = async () => {
        const sync = await import('../state/sync.js');
        sync.setActiveWorkspace(active ? '' : w.id);
        const { refreshWorkspaceLabel } = await import('./toolbar.js');
        await refreshWorkspaceLabel();
        await refreshSidebar();
        set({});
      };
    } else row.onclick = () => toggle(key);
    // A project dropped on the workspace goes in it, outside any folder, at the end.
    dropTarget(row, (e, what) => (what.kind === 'plan' ? 'into' : null), (_, what) =>
      arrange([...loose.map((x) => x.id).filter((id) => id !== what.id), what.id], w.id || null, null));
    parts.workspaces.append(row);
    if (!open) continue;

    for (const f of w.folders) {
      const inside = ordered(plansHere.filter((p) => p.folderId === f.id));
      const fKey = `folder:${f.id}`;
      const fOpen = state.expanded.has(fKey);
      const fMenu = (x, y) => showMenu(x, y, [
        { icon: '▢', label: 'New project in this folder…', run: () => { void import('./newproject.js').then((m) => m.newProjectWizard({ workspaceId: w.id, folderId: f.id })); } },
        '-',
        { icon: '✎', label: 'Rename folder…', run: async () => {
          const name = await promptText('Rename the folder', '', f.name);
          if (!name?.trim()) return;
          const sync = await import('../state/sync.js');
          await sync.renameFolder(w.id, f.id, name);
          await refreshSidebar();
        } },
        { icon: '🗑', label: 'Delete folder', danger: true, run: async () => {
          const { confirmDialog } = await import('./dialog.js');
          if (!(await confirmDialog(`Delete the folder “${f.name}”?`, `Its ${inside.length} project${inside.length === 1 ? '' : 's'} stay in ${w.name}, outside any folder. No project is deleted.`, 'Delete folder'))) return;
          const sync = await import('../state/sync.js');
          await sync.deleteFolder(w.id, f.id);
          await refreshSidebar();
        } },
      ]);
      const fRow = el('div', { class: 'side-item side-folder side-child', title: 'Click to open or close; drag projects onto it to file them',
        onclick: () => toggle(fKey), oncontextmenu: (e) => { e.preventDefault(); fMenu(e.clientX, e.clientY); } },
        el('span', { class: 'side-grip', text: '⠿' }),
        el('span', { class: 'side-twist', text: fOpen ? '▾' : '▸' }),
        el('span', { class: 'side-item-icon' }, ic('folder')),
        el('span', { class: 'side-item-label', text: f.name }),
        el('span', { class: 'side-count', text: String(inside.length) }),
        hoverButtons(iconButton('⋯', 'Folder menu', (e) => { const r = e.currentTarget.getBoundingClientRect(); fMenu(r.left, r.bottom + 4); }),
          iconButton('＋', 'New project in this folder', () => { void import('./newproject.js').then((m) => m.newProjectWizard({ workspaceId: w.id, folderId: f.id })); })));
      draggable(fRow, { kind: 'folder', id: f.id, workspaceId: w.id });
      dropTarget(fRow, (e, what) => (what.kind === 'plan' ? 'into' : what.kind === 'folder' && what.workspaceId === w.id && what.id !== f.id ? half(e) : null), async (side, what) => {
        if (what.kind === 'plan') {
          await arrange([...inside.map((x) => x.id).filter((id) => id !== what.id), what.id], w.id, f.id);
          if (!state.expanded.has(fKey)) toggle(fKey);
          return;
        }
        const ids = w.folders.map((x) => x.id).filter((id) => id !== what.id);
        let i = ids.indexOf(f.id);
        if (side === 'after') i++;
        ids.splice(i, 0, what.id);
        const sync = await import('../state/sync.js');
        await sync.arrangeFolders(w.id, ids);
        await refreshSidebar();
      });
      parts.workspaces.append(fRow);
      if (fOpen) {
        for (const p of inside) parts.workspaces.append(planRow(p, inside, w.id, f.id, 'side-child side-in-folder'));
        if (!inside.length) parts.workspaces.append(el('div', { class: 'side-empty side-in-folder', text: 'Empty — drag a project here' }));
      }
    }
    for (const p of loose) parts.workspaces.append(planRow(p, loose, w.id || null, null, 'side-child'));
    if (!plansHere.length && !w.folders.length) parts.workspaces.append(el('div', { class: 'side-empty side-child', text: 'No projects yet' }));
  }
  renderNow();
}
