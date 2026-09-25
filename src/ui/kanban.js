// Kanban: the open plan's tasks as cards in columns.
//
// Columns are the plan's own stages, which the plan stores and you can rename,
// reorder, add to and delete. Grouping by progress or by resource is there too,
// for when the question is "how far along is everything?" rather than "where is
// it in our process?".
//
// Every drop is a real edit. Moving a card to another stage writes that stage
// on the task; moving it to a stage marked *finished* also completes it, so the
// board and the schedule can never disagree about what is done.
//
// Summary tasks are not cards. They are the columns' subject matter, not items
// in them: their percent is computed from their children, so dropping one in a
// finished column would be a lie the scheduler immediately overwrites.

import { el, clear, formatHours } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { formatAssignments, isSummary, getResource, stages, stageOf } from '../model/model.js';
import { formatDate, formatDuration } from '../model/calendar.js';
import { showMenu, promptText, confirmDialog } from './dialog.js';

export const GROUPINGS = { stage: 'Stage', status: 'Progress', resource: 'Resource' };

const STATUS_COLUMNS = [
  { id: 'todo', label: 'Not started', percent: 0, match: (p) => p === 0 },
  { id: 'doing', label: 'In progress', percent: 50, match: (p) => p > 0 && p < 100 },
  { id: 'done', label: 'Complete', percent: 100, match: (p) => p === 100 },
];

/** The leaf tasks — the ones a card can stand for. */
function cardTasks() {
  const { project, schedule } = store;
  return project.tasks.filter((t, i) => !isSummary(project, i) && !schedule.tasks[t.id]?.cyclic);
}

function columnsFor(grouping) {
  const { project } = store;
  if (grouping === 'stage') return stages(project).map((st) => ({ id: st.id, label: st.name, stage: st }));
  if (grouping === 'resource') {
    const cols = project.resources.map((r) => ({ id: r.id, label: r.name, resourceId: r.id }));
    cols.push({ id: '__none', label: 'Unassigned', resourceId: null });
    return cols;
  }
  return STATUS_COLUMNS;
}

function tasksIn(column, grouping) {
  const { project, schedule } = store;
  const tasks = cardTasks();
  if (grouping === 'stage') return tasks.filter((t) => stageOf(project, t).id === column.id);
  if (grouping === 'resource') {
    if (column.resourceId === null) return tasks.filter((t) => !t.assignments.length);
    return tasks.filter((t) => t.assignments.some((a) => a.resourceId === column.resourceId));
  }
  return tasks.filter((t) => column.match(schedule.tasks[t.id]?.percent ?? 0));
}

/** What dropping a card in this column means. */
function applyDrop(taskId, column, grouping) {
  const t = store.project.tasks.find((x) => x.id === taskId);
  if (!t) return;
  if (grouping === 'stage') { act.setTaskStage(taskId, column.id); return; }
  if (grouping === 'resource') {
    if (column.resourceId === null) {
      for (const a of [...t.assignments]) act.unassignResource(taskId, a.resourceId);
      return;
    }
    if (t.assignments.some((a) => a.resourceId === column.resourceId)) return;
    for (const a of [...t.assignments]) act.unassignResource(taskId, a.resourceId);
    act.assignResource(taskId, column.resourceId, 1);
    return;
  }
  const now = store.schedule.tasks[taskId]?.percent ?? 0;
  // Coming back into "In progress" from either end starts it half done; a task
  // already part-way keeps the figure it had.
  if (column.id === 'doing' && now > 0 && now < 100) return;
  act.setPercent(taskId, column.percent);
}

function card(t, grouping) {
  const { project, schedule, ui } = store;
  const s = schedule.tasks[t.id];
  const names = formatAssignments(project, t);
  const node = el('article', {
    class: `kb-card sc-card${s.critical ? ' is-critical' : ''}${s.milestone ? ' is-milestone' : ''}${ui.selection.includes(t.id) ? ' is-sel' : ''}`,
    draggable: 'true', dataset: { id: t.id },
    onclick: (e) => act.selectTask(t.id, { extend: e.metaKey || e.ctrlKey }),
    ondblclick: () => { set({ rightOpen: true, rightTab: 'task', selection: [t.id] }); },
    oncontextmenu: (e) => {
      e.preventDefault();
      if (!ui.selection.includes(t.id)) act.selectTask(t.id);
      showMenu(e.clientX, e.clientY, [
        { label: 'Task information…', run: () => set({ rightOpen: true, rightTab: 'task' }) },
        '-',
        { label: 'Show on the Gantt chart', run: () => { act.revealTask(t.id); set({ view: 'gantt' }); } },
        '-',
        { label: 'Mark 100% complete', run: () => act.setPercent(t.id, 100) },
        { label: 'Mark 0% complete', run: () => act.setPercent(t.id, 0) },
        '-',
        { label: 'Delete task', danger: true, run: act.deleteSelection },
      ]);
    },
  });
  node.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', t.id);
    e.dataTransfer.effectAllowed = 'move';
    node.classList.add('is-drag');
  });
  node.addEventListener('dragend', () => node.classList.remove('is-drag'));

  node.append(
    el('div', { class: 'kb-card-head' },
      el('span', { class: 'kb-id sc-mono', text: `#${s.index}` }),
      s.milestone ? el('span', { class: 'kb-flag', text: '◆', title: 'Milestone' }) : null,
      s.critical ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-danger)' }, text: 'Critical' }) : null,
      s.deadlineMissed ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-danger)' }, text: 'Late' }) : null),
    el('h4', { class: 'kb-name', text: t.name }),
    el('div', { class: 'kb-dates sc-mono' }, `${formatDate(s.startIso, 'day')} → ${formatDate(s.finishIso, 'day')}`),
    el('div', { class: 'kb-meter sc-meter' }, el('span', { style: { '--value': `${s.percent}%` } })),
    el('div', { class: 'kb-foot' },
      el('span', { class: 'sc-faint', text: s.milestone ? 'Milestone' : formatDuration(s.duration) }),
      s.work ? el('span', { class: 'sc-faint', title: 'Allocated', text: formatHours(s.work) }) : null,
      s.spent ? el('span', { class: 'kb-spent', title: `Spent, of ${formatHours(s.work)} allocated`, text: formatHours(s.spent) }) : null,
      el('span', { class: 'sc-spacer' }),
      names ? el('span', { class: 'kb-who', title: names, text: initialsOf(project, t) }) : null));
  return node;
}

function initialsOf(project, task) {
  return task.assignments.map((a) => {
    const r = getResource(project, a.resourceId);
    if (!r) return '';
    return r.initials || r.name.split(/\s+/).map((w) => w[0] || '').join('').toUpperCase().slice(0, 3);
  }).filter(Boolean).join(' ');
}

export function renderKanban(root) {
  const { ui } = store;
  const grouping = ui.kanbanGroup || 'stage';
  clear(root);
  const pane = el('div', { class: 'kanban-pane' });
  root.append(pane);

  const cards = cardTasks();
  if (!cards.length) {
    pane.append(el('p', { class: 'empty', text: 'No tasks yet. Add some in the Gantt chart, and they appear here as cards.' }));
    return;
  }

  for (const column of columnsFor(grouping)) {
    const items = tasksIn(column, grouping);
    const body = el('div', { class: 'kb-body' });
    const head = el('header', { class: 'kb-col-head' },
      el('span', { class: 'sc-label', text: column.label }),
      column.stage?.done ? el('span', { class: 'kb-done-mark', title: 'Tasks here count as finished', text: '✓' }) : null,
      el('span', { class: 'sc-badge', text: String(items.length) }));
    if (column.stage) {
      head.append(el('button', {
        class: 'sc-button sc-button--ghost sc-button--icon sc-button--sm', text: '⋮', title: 'Column',
        onclick: (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const st = column.stage;
          showMenu(r.left - 150, r.bottom + 4, [
            { label: 'Rename…', run: async () => { const name = await promptText('Rename column', 'What is this stage called?', st.name); if (name) act.renameStageColumn(st.id, name); } },
            { label: st.done ? 'Stop meaning finished' : 'Tasks here are finished', run: () => act.setStageIsDone(st.id, !st.done) },
            '-',
            { label: 'Move left', run: () => act.moveStageColumn(st.id, -1) },
            { label: 'Move right', run: () => act.moveStageColumn(st.id, 1) },
            '-',
            { label: 'New column…', run: async () => { const name = await promptText('New column', 'What is this stage called?', 'New stage'); if (name) act.newStageColumn(name); } },
            { label: 'Delete column', danger: true, run: async () => {
              if (items.length && !(await confirmDialog('Delete this column?', `Its ${items.length} ${items.length === 1 ? 'task goes' : 'tasks go'} back to the first column. No task is deleted.`))) return;
              act.deleteStageColumn(st.id);
            } },
          ]);
        },
      }));
    }
    const col = el('section', { class: `kb-col${column.stage?.done ? ' is-done' : ''}` }, head, body);
    for (const t of items) body.append(card(t, grouping));

    const over = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('is-over'); };
    col.addEventListener('dragover', over);
    col.addEventListener('dragenter', over);
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('is-over'); });
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('is-over');
      const id = e.dataTransfer.getData('text/plain');
      if (id) applyDrop(id, column, grouping);
    });
    pane.append(col);
  }

  if (grouping === 'stage') {
    pane.append(el('button', {
      class: 'kb-add-col sc-card sc-brackets',
      onclick: async () => { const name = await promptText('New column', 'What is this stage called?', 'New stage'); if (name) act.newStageColumn(name); },
    }, el('div', { class: 'plan-new-mark', text: '+' }), el('div', { text: 'Add column' })));
  }
}
