// Application state with snapshot undo/redo.
//
// Plan edits go through `commit()`, which snapshots the plan first and
// recomputes the schedule and checks after; UI-only state (selection, view,
// zoom) changes through `set()` and is not undoable.

import { deepClone } from '../util.js';
import { createProject } from '../model/model.js';
import { computeSchedule } from '../model/schedule.js';
import { validate } from '../model/validate.js';
import { hosted } from '../host.js';

const MAX_HISTORY = 100;
const AUTOSAVE_KEY = 'project-planner:autosave';

// `label` names the view in menus and the status line; `short` is what fits in
// the tab strip once there are seven of them.
export const VIEWS = {
  projects: { label: 'Projects', short: 'Projects', glyph: '▢' },
  people: { label: 'People', short: 'People', glyph: '☺' },
  gantt: { label: 'Gantt Chart', short: 'Gantt', glyph: '▤' },
  kanban: { label: 'Kanban', short: 'Kanban', glyph: '▥' },
  alltasks: { label: 'All Tasks', short: 'All Tasks', glyph: '≣' },
  calendar: { label: 'Calendar', short: 'Calendar', glyph: '▦' },
  priority: { label: 'Priority', short: 'Priority', glyph: '⚑' },
  sheet: { label: 'Task Sheet', short: 'Tasks', glyph: '☰' },
  resources: { label: 'Resource Sheet', short: 'Resources', glyph: '◧' },
  usage: { label: 'Resource Usage', short: 'Usage', glyph: '▦' },
  network: { label: 'Network Diagram', short: 'Network', glyph: '⬡' },
};

export const store = {
  project: createProject(),
  schedule: null,
  issues: [],
  ui: {
    view: 'gantt',
    selection: [],          // task ids, in click order; the last is the active row
    activeCol: 'name',      // grid column the cursor is in
    resourceId: null,       // selected resource (resource views)
    collapsed: {},          // taskId → true when its subtasks are hidden
    zoom: 'day',            // gantt: 'day' | 'week' | 'month'
    kanbanGroup: 'stage',   // kanban: 'stage' | 'status' | 'resource'
    calendarWho: '',        // calendar: '' is everyone, otherwise a person key
    calendarScope: 'all',   // calendar: 'all' plans, or 'plan' for the open one
    split: 560,             // gantt: width of the grid half
    rightTab: 'task',
    bottomTab: 'checks',
    rightOpen: true,
    bottomOpen: true,
    fileName: null,
    dirty: false,
    hint: '',
    editing: null,          // { id, col } while a grid cell is being edited
  },
  _undo: [],
  _redo: [],
  _subs: new Set(),
  _rev: 0,
};

export function subscribe(fn) { store._subs.add(fn); return () => store._subs.delete(fn); }
export const revision = () => store._rev;

let emitQueued = false;
export function emit() {
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => { emitQueued = false; for (const fn of store._subs) fn(store); });
}

/** Change UI-only state. */
export function set(patch) {
  Object.assign(store.ui, patch);
  emit();
}

function recompute() {
  store.schedule = computeSchedule(store.project);
  store.issues = validate(store.project, store.schedule);
}

function changed() {
  store._rev++;
  recompute();
  store.ui.dirty = true;
  repairUi();
  autosave();
}

/**
 * Apply an undoable change to the plan. `fn` mutates the plan in place. An
 * edit that throws leaves the plan as it was; the error is shown as a hint
 * and re-thrown to the caller.
 */
export function commit(label, fn) {
  const before = deepClone(store.project);
  let result;
  try {
    result = fn(store.project);
  } catch (err) {
    store.project = before;
    store.ui.hint = err.message;
    emit();
    throw err;
  }
  store._undo.push({ label, project: before });
  if (store._undo.length > MAX_HISTORY) store._undo.shift();
  store._redo.length = 0;
  store.ui.hint = '';
  changed();
  emit();
  return result;
}

/** Like commit, but swallows the error after showing it. Returns undefined on failure. */
export function tryCommit(label, fn) {
  try { return commit(label, fn); } catch { return undefined; }
}

export const canUndo = () => store._undo.length > 0;
export const canRedo = () => store._redo.length > 0;
export function undo() { step(store._undo, store._redo); }
export function redo() { step(store._redo, store._undo); }
function step(from, to) {
  const entry = from.pop();
  if (!entry) return;
  to.push({ label: entry.label, project: store.project });
  store.project = entry.project;
  store.ui.hint = '';
  changed();
  emit();
}

/** Drop selection that points at things the plan no longer holds. */
function repairUi() {
  const { ui, project } = store;
  const ids = new Set(project.tasks.map((t) => t.id));
  ui.selection = ui.selection.filter((id) => ids.has(id));
  for (const id of Object.keys(ui.collapsed)) if (!ids.has(id)) delete ui.collapsed[id];
  if (ui.resourceId && !project.resources.some((r) => r.id === ui.resourceId)) ui.resourceId = null;
  if (ui.editing && !ids.has(ui.editing.id) && !project.resources.some((r) => r.id === ui.editing.id)) ui.editing = null;
}

export function loadProject(project, fileName = null) {
  store.project = project;
  store._undo.length = 0;
  store._redo.length = 0;
  store._rev++;
  recompute();
  Object.assign(store.ui, { selection: [], resourceId: null, collapsed: {}, fileName, dirty: false, hint: '', editing: null });
  autosave();
  emit();
}

export function markSaved(fileName) {
  store.ui.dirty = false;
  if (fileName) store.ui.fileName = fileName;
  emit();
}

// In the macOS app each window is a document and the app saves it; one shared
// browser autosave would only make windows overwrite each other.
function autosave() {
  if (hosted) return;
  try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(store.project)); } catch { /* private mode, quota, or no localStorage */ }
}
export function readAutosave() {
  if (hosted) return null;
  try { return JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || 'null'); } catch { return null; }
}

recompute();
