// All Tasks: every task in every plan on the shelf, in one list.
//
// The other views answer "what is in this plan?". This one answers the
// question you actually have on a Monday — "what is on me this week, across
// everything?" — so it reads every plan the shelf holds, not just the open
// one, and a row opens the plan it belongs to.
//
// Each plan is parsed and scheduled once and kept until that plan's record
// changes, because scheduling twenty plans on every keystroke in the search
// box would be madness.

import { el, clear } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { planRecords, openPlan } from '../state/sync.js';
import { parse } from '../io/json.js';
import { computeSchedule } from '../model/schedule.js';
import { isSummary, formatAssignments } from '../model/model.js';
import { formatDate, toDay, today } from '../model/calendar.js';

export const FILTERS = {
  all: { label: 'All', keep: () => true },
  open: { label: 'Unfinished', keep: (r) => r.percent < 100 },
  late: { label: 'Late', keep: (r) => r.late },
  soon: { label: 'Next 14 days', keep: (r) => r.startDay <= toDay(today()) + 14 && r.percent < 100 },
  critical: { label: 'Critical', keep: (r) => r.critical },
  unassigned: { label: 'Unassigned', keep: (r) => !r.who },
};

/** planId → { updatedAt, rows }. Scheduling is the expensive part. */
const cache = new Map();
let rows = [];
let loading = true;
let loaded = false;
let query = '';
let filter = 'all';

function rowsOf(record) {
  const hit = cache.get(record.id);
  if (hit && hit.updatedAt === record.updatedAt) return hit.rows;
  let out = [];
  try {
    const project = parse(record.body).project;
    const schedule = computeSchedule(project);
    const status = project.statusDate ? toDay(project.statusDate) : toDay(today());
    out = project.tasks
      .map((t, i) => ({ t, i }))
      .filter(({ i }) => !isSummary(project, i))
      .map(({ t }) => {
        const s = schedule.tasks[t.id];
        return {
          planId: record.id, planName: project.name || record.name, taskId: t.id,
          index: s.index, name: t.name, startDay: s.start, startIso: s.startIso, finishIso: s.finishIso,
          deadline: t.deadline, percent: s.percent, critical: s.critical, milestone: s.milestone,
          who: formatAssignments(project, t),
          late: s.percent < 100 && s.finish < status,
          deadlineMissed: s.deadlineMissed,
        };
      });
  } catch {
    out = [];
  }
  cache.set(record.id, { updatedAt: record.updatedAt, rows: out });
  return out;
}

export async function reloadAllTasks() {
  loading = true;
  set({});
  try {
    const records = await planRecords();
    rows = records.flatMap(rowsOf).sort((a, b) => (a.finishIso < b.finishIso ? -1 : a.finishIso > b.finishIso ? 1 : a.planName.localeCompare(b.planName)));
  } catch {
    rows = [];
  }
  loading = false;
  loaded = true;
  set({});
}

function visible() {
  const q = query.trim().toLowerCase();
  const keep = FILTERS[filter]?.keep ?? (() => true);
  return rows.filter((r) => keep(r) && (!q || `${r.name} ${r.planName} ${r.who}`.toLowerCase().includes(q)));
}

async function openRow(r) {
  if (r.planId !== store.project.id && !(await openPlan(r.planId))) return;
  act.revealTask(r.taskId);
  act.selectTask(r.taskId);
  set({ view: 'gantt', rightTab: 'task' });
}

export function renderAllTasks(root) {
  clear(root);
  if (!loaded && !loading) void reloadAllTasks();
  const pane = el('div', { class: 'alltasks-pane' });
  root.append(pane);

  const search = el('input', {
    class: 'sc-input', type: 'search', placeholder: 'Search every plan', value: query,
    oninput: (e) => { query = e.target.value; renderAllTasks(root); e.target.focus(); },
    onkeydown: (e) => e.stopPropagation(),
  });
  pane.append(el('div', { class: 'alltasks-head' },
    el('div', { class: 'row' }, ...Object.entries(FILTERS).map(([id, f]) => el('button', {
      class: `sc-button sc-button--sm${filter === id ? ' is-on' : ''}`, text: f.label,
      onclick: () => { filter = id; renderAllTasks(root); },
    }))),
    el('span', { class: 'sc-spacer' }),
    search));

  const list = visible();
  if (loading) { pane.append(el('p', { class: 'empty', text: 'Reading every plan on the shelf…' })); return; }
  if (!list.length) {
    pane.append(el('p', { class: 'empty', text: rows.length ? 'No task matches that.' : 'No plans on the shelf yet.' }));
    return;
  }

  const table = el('table', { class: 'sc-table alltasks' },
    el('thead', {}, el('tr', {},
      el('th', { text: 'Project' }), el('th', { text: 'Task' }), el('th', { text: 'Start' }), el('th', { text: 'Finish' }),
      el('th', { text: 'Deadline' }), el('th', { text: 'Assignees' }), el('th', { class: 'num', text: '%' }), el('th', { text: '' }))));
  const body = el('tbody');
  for (const r of list) {
    body.append(el('tr', { class: 'clickable', onclick: () => { void openRow(r); } },
      el('td', {}, el('span', { class: 'at-plan', text: r.planName })),
      el('td', {}, el('span', { class: `at-name${r.milestone ? ' is-milestone' : ''}`, text: r.name })),
      el('td', { class: 'sc-mono sc-muted', text: formatDate(r.startIso, 'day') }),
      el('td', { class: 'sc-mono sc-muted', text: formatDate(r.finishIso, 'day') }),
      el('td', { class: `sc-mono${r.deadlineMissed ? ' warn' : ' sc-muted'}`, text: r.deadline ? formatDate(r.deadline, 'day') : '' }),
      el('td', { text: r.who }),
      el('td', { class: 'num', text: `${r.percent}%` }),
      el('td', {},
        r.late ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-warning)' }, text: 'Late' }) : null,
        r.critical ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-danger)' }, text: 'Critical' }) : null)));
  }
  table.append(body);
  pane.append(table);
  pane.append(el('p', { class: 'sc-faint small projects-note', text: `${list.length} of ${rows.length} tasks, across ${new Set(rows.map((r) => r.planId)).size} plans` }));
}
