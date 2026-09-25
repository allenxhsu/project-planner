// Editing commands over the store: what menus, keys, toolbar and grid all call.

import { store, set, commit, tryCommit, emit } from './store.js';
import * as agendaModule from '../model/agenda.js';
import {
  insertTask, removeTasks, indentTasks, outdentTasks, moveTask, linkChain, unlinkAll, link, unlink, taskIndex, descendants,
  setTaskField, setFinish, isSummary, getTask, addResource, removeResource, setResourceField, assign, unassign,
  setStage, addStage, renameStage, removeStage, moveStage, setStageDone,
  addTimesheet, removeTimesheet, setTimesheetField, breakIntoSubtasks, isSummary as isSummaryAt,
  addTimeBlock, setTimeBlockField, removeTimeBlock,
} from '../model/model.js';

export const hint = (text) => set({ hint: text });
/** Run an undoable edit; true when it applied, false when it threw (the message is shown as the hint). */
function attempt(label, fn) { try { commit(label, fn); return true; } catch { return false; } }

export const activeId = () => store.ui.selection[store.ui.selection.length - 1] || null;
export const activeTask = () => getTask(store.project, activeId());
export const activeInfo = () => (activeId() ? store.schedule.tasks[activeId()] : null);

// ---------------------------------------------------------------- selection

export function selectTask(id, { extend = false, range = false } = {}) {
  const { ui, project } = store;
  if (!id) { set({ selection: [] }); return; }
  if (range && ui.selection.length) {
    const a = taskIndex(project, activeId()), b = taskIndex(project, id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const ids = project.tasks.slice(lo, hi + 1).map((t) => t.id).filter((x) => visibleIds().has(x));
    set({ selection: id === project.tasks[lo].id ? ids.reverse() : ids });
  } else if (extend) {
    set({ selection: ui.selection.includes(id) ? ui.selection.filter((x) => x !== id) : [...ui.selection, id] });
  } else set({ selection: [id] });
}
export function selectAll() { set({ selection: store.project.tasks.map((t) => t.id) }); }

/** Tasks shown in the grid: everything not hidden under a collapsed summary. */
export function visibleTasks() {
  const { project, ui } = store;
  const out = [];
  let hideBelow = Infinity;
  project.tasks.forEach((t, i) => {
    if (t.level > hideBelow) return;
    hideBelow = Infinity;
    out.push(t);
    if (ui.collapsed[t.id] && isSummary(project, i)) hideBelow = t.level;
  });
  return out;
}
export const visibleIds = () => new Set(visibleTasks().map((t) => t.id));

export function toggleCollapse(id) {
  const collapsed = { ...store.ui.collapsed };
  if (collapsed[id]) delete collapsed[id]; else collapsed[id] = true;
  set({ collapsed });
}
export function collapseAll(on) {
  const { project } = store;
  const collapsed = {};
  if (on) project.tasks.forEach((t, i) => { if (isSummary(project, i)) collapsed[t.id] = true; });
  set({ collapsed });
}
export function revealTask(id) {
  const { project, ui } = store;
  const i = taskIndex(project, id);
  if (i < 0) return;
  const collapsed = { ...ui.collapsed };
  let lvl = project.tasks[i].level;
  for (let j = i - 1; j >= 0; j--) if (project.tasks[j].level < lvl) { delete collapsed[project.tasks[j].id]; lvl = project.tasks[j].level; }
  set({ collapsed });
}

/** Move the active row up or down among the visible rows. */
export function moveCursor(delta, { extend = false } = {}) {
  const rows = visibleTasks();
  if (!rows.length) return;
  const cur = rows.findIndex((t) => t.id === activeId());
  const next = rows[Math.max(0, Math.min(rows.length - 1, (cur < 0 ? (delta > 0 ? -1 : rows.length) : cur) + delta))];
  selectTask(next.id, { range: extend });
}

// ---------------------------------------------------------------- tasks

export function newTaskBelow() {
  const { project } = store;
  const id = activeId();
  const at = id ? taskIndex(project, id) + 1 + descendants(project, taskIndex(project, id)).length : project.tasks.length;
  const t = commit('Insert task', (p) => insertTask(p, at, id ? { level: getTask(p, id).level } : {}));
  set({ selection: [t.id], activeCol: 'name', editing: { kind: 'task', id: t.id, col: 'name' } });
  return t;
}
export function newTaskAbove() {
  const { project } = store;
  const id = activeId();
  const at = id ? taskIndex(project, id) : 0;
  const t = commit('Insert task', (p) => insertTask(p, at, id ? { level: getTask(p, id).level } : {}));
  set({ selection: [t.id], activeCol: 'name', editing: { kind: 'task', id: t.id, col: 'name' } });
  return t;
}
export function newMilestone() {
  const t = newTaskBelow();
  tryCommit('Milestone', (p) => setTaskField(p, t.id, 'milestone', true));
}
export function deleteSelection() {
  const ids = store.ui.selection;
  if (!ids.length) { hint('Select a task first.'); return; }
  const { project } = store;
  const first = Math.min(...ids.map((id) => taskIndex(project, id)));
  commit(`Delete ${ids.length > 1 ? `${ids.length} tasks` : 'task'}`, (p) => removeTasks(p, ids));
  const next = store.project.tasks[Math.min(first, store.project.tasks.length - 1)];
  set({ selection: next ? [next.id] : [] });
}
export function indentSelection() {
  const ids = store.ui.selection;
  if (!ids.length) return;
  const n = tryCommit('Indent', (p) => indentTasks(p, ids));
  if (n === 0) hint('The first task in a group cannot be indented further.');
}
export function outdentSelection() {
  const ids = store.ui.selection;
  if (!ids.length) return;
  const n = tryCommit('Outdent', (p) => outdentTasks(p, ids));
  if (n === 0) hint('The task is already at the top level.');
}
export function moveSelection(dir) {
  const id = activeId();
  if (!id) return;
  const ok = tryCommit(dir < 0 ? 'Move up' : 'Move down', (p) => moveTask(p, id, dir));
  if (!ok) hint('There is no sibling to move past.');
}
export function linkSelection() {
  const ids = store.ui.selection;
  if (ids.length < 2) { hint('Select two or more tasks (⇧-click or ⌘-click), then link them in order.'); return; }
  const idx = ids.map((id) => taskIndex(store.project, id)).sort((a, b) => a - b);
  const missing = idx.slice(1).some((i, k) => !store.project.tasks[i].predecessors.some((l) => l.id === store.project.tasks[idx[k]].id));
  if (!missing) { hint('Those tasks are already linked in that order.'); return; }
  const n = tryCommit('Link tasks', (p) => linkChain(p, ids));
  if (n === 0) hint('Those tasks cannot be linked (a summary and its own subtask, or a circular chain).');
}
export function unlinkSelection() {
  const ids = store.ui.selection;
  if (!ids.length) return;
  const n = tryCommit('Unlink tasks', (p) => unlinkAll(p, ids));
  if (n === 0) hint('Nothing was linked.');
}
export function linkTasks(fromId, toId, type = 'FS', lag = 0) {
  return attempt('Link tasks', (p) => link(p, fromId, toId, type, lag));
}
export function unlinkTasks(fromId, toId) { tryCommit('Unlink', (p) => unlink(p, fromId, toId)); }

export function toggleMilestone() {
  const t = activeTask();
  if (!t) return;
  tryCommit(t.milestone ? 'Not a milestone' : 'Milestone', (p) => setTaskField(p, t.id, 'milestone', !t.milestone));
}

/** Set a task field from user input; errors surface as the status hint. Returns true on success. */
export function editTask(id, field, value) {
  const label = { name: 'Rename', duration: 'Duration', start: 'Start', finish: 'Finish', percent: 'Progress', predecessors: 'Links', resources: 'Assignments' }[field] || `Edit ${field}`;
  if (field === 'finish') {
    const info = store.schedule.tasks[id];
    return attempt(label, (p) => setFinish(p, id, info.startIso, value));
  }
  return attempt(label, (p) => setTaskField(p, id, field, value));
}
export function setPercent(id, percent) { return editTask(id, 'percent', percent); }
/** Drag a bar: pin the task to a new start with a Start No Earlier Than constraint. */
export function pinStart(id, iso) {
  return attempt('Move task', (p) => { const t = getTask(p, id); t.constraint = { type: t.constraint.type === 'MSO' ? 'MSO' : 'SNET', date: iso }; });
}
export function setDuration(id, days) { return editTask(id, 'duration', days); }

// ---------------------------------------------------------------- resources

export function newResource() {
  const r = commit('New resource', (p) => addResource(p, {}));
  set({ resourceId: r.id, editing: { kind: 'resource', id: r.id, col: 'name' } });
  return r;
}
export function deleteResource(id = store.ui.resourceId) {
  if (!id) { hint('Select a resource first.'); return; }
  commit('Delete resource', (p) => removeResource(p, id));
  set({ resourceId: null });
}
export function editResource(id, field, value) {
  return attempt('Edit resource', (p) => setResourceField(p, id, field, value));
}
export function assignResource(taskId, resourceId, units = 1) { return attempt('Assign', (p) => assign(p, taskId, resourceId, units)); }
export function unassignResource(taskId, resourceId) { tryCommit('Unassign', (p) => unassign(p, taskId, resourceId)); }

// ---------------------------------------------------------------- phases

/** Say which phase the plan is in; '' means every phase at once. */
export function setCurrentPhase(id) {
  return attempt('Current phase', (p) => { p.currentPhaseId = id || null; });
}

// ---------------------------------------------------------------- time blocks

export function newTimeBlock(props) { return commit('New time block', (p) => addTimeBlock(p, props)); }
export function editTimeBlock(id, field, value) { return attempt('Edit time block', (p) => setTimeBlockField(p, id, field, value)); }
export function deleteTimeBlock(id) { return attempt('Delete time block', (p) => removeTimeBlock(p, id)); }
export function setTaskTimeBlock(taskId, blockId) { return editTask(taskId, 'timeBlock', blockId); }

// ---------------------------------------------------------------- calendar

/** Put every unfinished leaf task on the calendar, for a plan starting out. */
export function showAllInCalendar() {
  return attempt('Show in calendar', (p) => {
    p.tasks.forEach((t, i) => {
      if (isSummaryAt(p, i) || t.milestone || (t.percent ?? 0) === 100) return;
      t.calendar = { ...t.calendar, show: true };
    });
  });
}

/** Cut a task into parts. Asks how many, then names them after it. */
export async function breakUpDialog(taskId) {
  const t = getTask(store.project, taskId);
  if (!t) return;
  const { formDialog, showText } = await import('../ui/dialog.js');
  const answer = await formDialog('Break into subtasks', [
    { key: 'parts', label: 'How many parts', type: 'text', value: '3', hint: `“${t.name}” is ${t.duration} days; the parts divide that between them and run one after another.` },
    { key: 'names', label: 'Names (one per line, optional)', type: 'textarea', rows: 4, value: '' },
  ], 'Break up');
  if (!answer) return;
  const parts = parseInt(answer.parts, 10);
  if (!Number.isFinite(parts) || parts < 2) { hint('Two parts or more.'); return; }
  const names = String(answer.names || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const made = tryCommit('Break into subtasks', (p) => breakIntoSubtasks(p, taskId, parts, names));
  if (made) { set({ selection: [made[0].id] }); revealTask(made[0].id); }
  else showText('That task could not be broken up', store.ui.hint || 'Unknown reason.');
}

// ---------------------------------------------------------------- timesheets

export function logTime({ taskId, resourceId, date, hours, note }) {
  return attempt('Log time', (p) => addTimesheet(p, { taskId, resourceId, date, hours, note }));
}
export function editTimeLine(id, field, value) { return attempt('Edit timesheet', (p) => setTimesheetField(p, id, field, value)); }
export function deleteTimeLine(id) { return attempt('Delete timesheet line', (p) => removeTimesheet(p, id)); }

// ---------------------------------------------------------------- stages

export function setTaskStage(taskId, stageId) { return attempt('Move task', (p) => setStage(p, taskId, stageId)); }
export function newStageColumn(name) { return commit('New stage', (p) => addStage(p, name)); }
export function renameStageColumn(id, name) { return attempt('Rename stage', (p) => renameStage(p, id, name)); }
export function deleteStageColumn(id) { return attempt('Delete stage', (p) => removeStage(p, id)); }
export function moveStageColumn(id, dir) { return attempt('Move stage', (p) => { if (!moveStage(p, id, dir)) throw new Error('There is no column that way.'); }); }
export function setStageIsDone(id, done) { return attempt('Stage means finished', (p) => setStageDone(p, id, done)); }

// ---------------------------------------------------------------- project

export function setProjectInfo(patch) {
  tryCommit('Project information', (p) => {
    if (patch.name !== undefined) p.name = String(patch.name).trim() || 'Untitled project';
    if (patch.start !== undefined) p.start = patch.start;
    if (patch.statusDate !== undefined) p.statusDate = patch.statusDate || null;
    if (patch.currency !== undefined) p.currency = patch.currency || '$';
  });
}
export function setAgenda(patch) {
  return attempt('Working hours', (p) => {
    const next = { blockHours: 1, ...(p.agenda || {}), ...patch };
    const { BLOCK_CHOICES } = agendaModule;
    if (!BLOCK_CHOICES.includes(+next.blockHours)) throw new Error(`A block is one of ${BLOCK_CHOICES.join(', ')} hours.`);
    p.agenda = { blockHours: +next.blockHours, timeBlockId: next.timeBlockId || null };
  });
}

export function setCalendar(cal) {
  tryCommit('Working time', (p) => { p.calendar = { ...p.calendar, ...cal }; });
}
export { emit };
