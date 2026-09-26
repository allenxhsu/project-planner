// Task columns, rows and grid behaviour shared by the Gantt chart and the Task Sheet.

import { el } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { formatPredecessors, formatAssignments, isSummary, taskIndex, CONSTRAINTS, stageOf, URGENCIES, urgencyOf, pinsOf } from '../model/model.js';
import { lateness, lateSentence } from './calendar.js';
import { formatDate, formatDuration } from '../model/calendar.js';
import { formatMoney, formatHours, clear } from '../util.js';
import { renderGrid } from './grid.js';
import { showMenu } from './dialog.js';

export const COLUMN_DEFS = {
  id: { label: '#', width: 40, align: 'right', readonly: true },
  ind: { label: '', width: 34, readonly: true },
  wbs: { label: 'WBS', width: 60, readonly: true },
  name: { label: 'Task Name', width: 250, edit: 'text' },
  duration: { label: 'Duration', width: 78, edit: 'text', align: 'right' },
  start: { label: 'Start', width: 108, edit: 'date' },
  finish: { label: 'Finish', width: 108, edit: 'date' },
  predecessors: { label: 'Predecessors', width: 110, edit: 'text' },
  resources: { label: 'Resource Names', width: 180, edit: 'text' },
  percent: { label: '% Complete', width: 84, edit: 'text', align: 'right' },
  work: { label: 'Work', width: 70, edit: 'text', align: 'right' },
  spent: { label: 'Spent', width: 70, readonly: true, align: 'right' },
  remaining: { label: 'Left', width: 70, readonly: true, align: 'right' },
  stage: { label: 'Status', width: 120, readonly: true },
  urgency: { label: 'Urgency', width: 96, edit: 'select', options: Object.entries(URGENCIES).map(([value, u]) => ({ value, label: u.label })) },
  cost: { label: 'Cost', width: 90, readonly: true, align: 'right' },
  slack: { label: 'Slack', width: 60, readonly: true, align: 'right' },
  critical: { label: 'Critical', width: 62, readonly: true },
  constraint: { label: 'Constraint', width: 168, edit: 'select', options: Object.entries(CONSTRAINTS).map(([value, c]) => ({ value, label: c.label })) },
  constraintDate: { label: 'Constraint Date', width: 118, edit: 'date' },
  deadline: { label: 'Deadline', width: 108, edit: 'date' },
  notes: { label: 'Notes', width: 260, edit: 'text' },
};
export const GANTT_COLUMNS = ['id', 'ind', 'name', 'duration', 'start', 'finish', 'predecessors', 'resources'];
export const SHEET_COLUMNS = ['id', 'ind', 'wbs', 'name', 'duration', 'start', 'finish', 'predecessors', 'resources', 'percent', 'urgency', 'stage', 'work', 'spent', 'remaining', 'cost', 'slack', 'critical', 'constraint', 'constraintDate', 'deadline', 'notes'];
export const columnsForView = (view) => (view === 'sheet' ? SHEET_COLUMNS : GANTT_COLUMNS);

export const taskColumns = (keys) => keys.map((key) => ({ key, ...COLUMN_DEFS[key] }));

/** The calendar's lateness for one task of the open plan, or null. */
function lateFor(taskId) {
  try { return lateness().find((l) => l.taskId === taskId && l.planId === store.project.id) || null; } catch { return null; }
}

/** Small glyphs in the indicator column. */
function indicators(task, info) {
  const marks = [];
  const issues = store.issues.filter((i) => i.taskId === task.id);
  const worst = issues.find((i) => i.level === 'error') || issues.find((i) => i.level === 'warning');
  if (worst) marks.push(el('span', { class: `ind ind-${worst.level}`, text: worst.level === 'error' ? '⨂' : '⚠', title: issues.map((i) => i.text).join('\n') }));
  if (info.percent === 100) marks.push(el('span', { class: 'ind ind-done', text: '✓', title: 'Complete' }));
  if (task.archived) marks.push(el('span', { class: 'ind ind-archived', text: '▣', title: 'Archived — off the calendar and the priority list' }));
  if (task.constraint?.type !== 'ASAP') marks.push(el('span', { class: 'ind ind-pin', text: '⚑', title: `${CONSTRAINTS[task.constraint.type].label} ${formatDate(task.constraint.date)}` }));
  // The calendar's verdict, when it has one: the plan's dates can make a
  // deadline that the week, laid out beside every other project, cannot.
  const late = lateFor(task.id);
  if (late) marks.push(el('span', { class: 'ind ind-error ind-late', text: '⏱', title: lateSentence(late) }));
  else if (task.deadline) marks.push(el('span', { class: `ind ${info.deadlineMissed ? 'ind-error' : 'ind-deadline'}`, text: '▽', title: `Deadline ${formatDate(task.deadline)}` }));
  const pins = pinsOf(task).length;
  if (pins) marks.push(el('span', { class: 'ind ind-pinned', text: '⌖', title: `${pins} block${pins === 1 ? '' : 's'} pinned on the calendar` }));
  if (task.notes) marks.push(el('span', { class: 'ind ind-note', text: '≡', title: task.notes }));
  return el('span', { class: 'ind-wrap' }, ...marks);
}

export function taskRows(ids) {
  const { project, schedule, ui } = store;
  return ids.map((id) => {
    const i = taskIndex(project, id);
    const t = project.tasks[i];
    const s = schedule.tasks[id];
    const summary = isSummary(project, i);
    return {
      id, indent: t.level - 1, summary, toggle: summary ? (ui.collapsed[id] ? 'closed' : 'open') : null,
      class: `${s.critical && !summary ? 'is-critical' : ''}${s.milestone ? ' is-milestone' : ''}${s.cyclic ? ' is-cyclic' : ''}`,
      cells: {
        id: s.index, ind: indicators(t, s), wbs: s.wbs, name: t.name, duration: summary ? formatDuration(s.duration) : formatDuration(t.duration),
        start: formatDate(s.startIso), finish: formatDate(s.finishIso), predecessors: formatPredecessors(project, t), resources: formatAssignments(project, t),
        percent: `${s.percent}%`, urgency: urgencyOf(t) === 'normal' ? '' : URGENCIES[urgencyOf(t)].label, stage: stageOf(project, t).name, work: s.work ? formatHours(s.work) : '',
        spent: s.spent ? formatHours(s.spent) : '', remaining: s.work ? formatHours(s.remaining) : '', cost: s.cost ? formatMoney(s.cost, project.currency) : '',
        slack: summary ? '' : `${s.slack}d`, critical: s.critical ? 'Yes' : '', constraint: t.constraint?.type === 'ASAP' ? '' : CONSTRAINTS[t.constraint.type].label,
        constraintDate: t.constraint?.date ? formatDate(t.constraint.date) : '', deadline: t.deadline ? formatDate(t.deadline) : '', notes: t.notes,
      },
      raw: {
        name: t.name, duration: formatDuration(t.duration), start: s.startIso, finish: s.finishIso, predecessors: formatPredecessors(project, t),
        resources: formatAssignments(project, t), percent: String(s.percent), urgency: urgencyOf(t), work: t.work == null ? '' : String(t.work),
        constraint: t.constraint?.type || 'ASAP', constraintDate: t.constraint?.date || '',
        deadline: t.deadline || '', notes: t.notes,
      },
    };
  });
}

const FIELD_OF = { constraint: 'constraintType' };

export function gridHandlers(columnKeys = columnsForView(store.ui.view)) {
  const editable = columnKeys.filter((k) => COLUMN_DEFS[k].edit);
  return {
    onSelect: (id, e) => act.selectTask(id, { extend: e.metaKey || e.ctrlKey, range: e.shiftKey }),
    onCell: (id, col, e) => {
      const { ui } = store;
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (ui.editing) return;
      if (act.activeId() === id && ui.activeCol === col && ui.selection.length === 1 && COLUMN_DEFS[col].edit) set({ editing: { kind: 'task', id, col } });
      else set({ activeCol: col });
    },
    onEdit: (id, col) => set({ selection: [id], activeCol: col, editing: { kind: 'task', id, col } }),
    onCommit: (id, col, value, { next }) => {
      const row = taskRows([id])[0];
      const unchanged = row && String(value) === String(row.raw[col] ?? '');
      const ok = unchanged || act.editTask(id, FIELD_OF[col] || col, value);
      if (!ok) { set({ editing: { kind: 'task', id, col, seed: value } }); return; }
      set({ editing: null });
      if (next === 'down') act.moveCursor(1);
      else if (next === 'up') act.moveCursor(-1);
      else if (next === 'right' || next === 'left') {
        // Tab moves the cursor, as in a spreadsheet; typing then starts a fresh edit.
        const i = editable.indexOf(col);
        const k = editable[i + (next === 'right' ? 1 : -1)];
        if (k) set({ activeCol: k });
      }
    },
    onCancel: () => set({ editing: null }),
    onToggle: (id) => act.toggleCollapse(id),
    onContext: (id, e) => {
      if (!store.ui.selection.includes(id)) act.selectTask(id);
      const t = act.activeTask();
      showMenu(e.clientX, e.clientY, [
        { label: 'Task information…', key: '⌘I', run: () => set({ rightOpen: true, rightTab: 'task' }) }, '-',
        { label: 'Insert task below', key: 'Ins', run: act.newTaskBelow }, { label: 'Insert task above', run: act.newTaskAbove }, { label: 'Insert milestone', run: act.newMilestone }, '-',
        { label: 'Indent', key: '⌥⇧→', run: act.indentSelection }, { label: 'Outdent', key: '⌥⇧←', run: act.outdentSelection },
        { label: 'Move up', key: '⌥⇧↑', run: () => act.moveSelection(-1) }, { label: 'Move down', key: '⌥⇧↓', run: () => act.moveSelection(1) }, '-',
        { label: 'Link selected tasks', key: '⌘L', run: act.linkSelection, disabled: store.ui.selection.length < 2 }, { label: 'Unlink', key: '⇧⌘L', run: act.unlinkSelection }, '-',
        { label: t?.milestone ? 'Not a milestone' : 'Mark as milestone', run: act.toggleMilestone },
        { label: 'Mark 100% complete', run: () => act.setPercent(id, 100) }, { label: 'Mark 0% complete', run: () => act.setPercent(id, 0) }, '-',
        { label: `Delete ${store.ui.selection.length > 1 ? `${store.ui.selection.length} tasks` : 'task'}`, key: 'Del', danger: true, run: act.deleteSelection },
      ]);
    },
  };
}

/** Start editing the active cell, optionally seeding it with a typed character. */
export function editActiveCell(seed) {
  const { ui } = store;
  const id = act.activeId();
  if (!id || !COLUMN_DEFS[ui.activeCol]?.edit || !['gantt', 'sheet'].includes(ui.view)) return false;
  set({ selection: [id], editing: { kind: 'task', id, col: ui.activeCol, ...(seed !== undefined ? { seed } : {}) } });
  return true;
}
export function moveActiveCol(delta) {
  const keys = columnsForView(store.ui.view).filter((k) => !COLUMN_DEFS[k].readonly);
  const i = keys.indexOf(store.ui.activeCol);
  const k = keys[Math.max(0, Math.min(keys.length - 1, (i < 0 ? 0 : i) + delta))];
  if (k) set({ activeCol: k });
}

export function renderTaskSheet(root) {
  const { ui } = store;
  clear(root);
  const pane = el('div', { class: 'sheet-pane' });
  root.append(pane);
  renderGrid(pane, { ...gridHandlers(SHEET_COLUMNS), columns: taskColumns(SHEET_COLUMNS), rows: taskRows(act.visibleTasks().map((t) => t.id)), selected: new Set(ui.selection), activeId: act.activeId(), activeCol: ui.activeCol, editing: ui.editing?.kind === 'task' ? ui.editing : null, onAppend: () => { set({ selection: [] }); act.newTaskBelow(); } });
}
