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
import { planRecords, openPlan, isCurrentWork } from '../state/sync.js';
import { parse } from '../io/json.js';
import { computeSchedule } from '../model/schedule.js';
import { isSummary, formatAssignments, phaseOf, getPhase, phases } from '../model/model.js';
import { hoursLeft } from '../model/agenda.js';
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
/**
 * How the list is grouped: not at all, by project, or by project and then
 * phase — a project's weeks or stages, each with its tasks, its hours and its
 * deadlines, and the phase the plan is in marked as active.
 */
export const GROUPS = { none: 'No grouping', project: 'Project', phase: 'Project › Phase' };
let grouping = 'phase';
const folded = new Set();

function rowsOf(record) {
  const hit = cache.get(record.id);
  if (hit && hit.updatedAt === record.updatedAt) return hit.rows;
  let out = [];
  try {
    const project = parse(record.body).project;
    // Templates and archived plans are not work in hand, so not in this list.
    if (!isCurrentWork(project)) { cache.set(record.id, { updatedAt: record.updatedAt, rows: [] }); return []; }
    const schedule = computeSchedule(project);
    const status = project.statusDate ? toDay(project.statusDate) : toDay(today());
    out = project.tasks
      .map((t, i) => ({ t, i }))
      .filter(({ i }) => !isSummary(project, i))
      .map(({ t }) => {
        const s = schedule.tasks[t.id];
        const phaseId = phaseOf(project, t.id);
        return {
          planId: record.id, planName: project.name || record.name, taskId: t.id,
          phaseId, phaseName: phaseId ? getPhase(project, phaseId)?.name : null,
          phaseOrder: phaseId ? phases(project).findIndex((ph) => ph.id === phaseId) : 1e6,
          activePhase: !!phaseId && project.currentPhaseId === phaseId,
          order: project.tasks.findIndex((x) => x.id === t.id),
          hours: s.milestone ? 0 : hoursLeft(project, s, t),
          archived: !!t.archived,
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
  const { taskSheet } = await import('./blockmenu.js');
  await taskSheet({ planId: r.planId, taskId: r.taskId });
  void reloadAllTasks();
}

/** A new task at the end of a group, in its plan and its phase, opened at once. */
async function addTo(planId, phaseId) {
  if (planId !== store.project.id && !(await openPlan(planId))) return;
  const made = act.newTaskInPhase(phaseId);
  if (!made) return;
  const { taskSheet } = await import('./blockmenu.js');
  await taskSheet({ planId, taskId: made.id });
  void reloadAllTasks();
}

const hrs = (h) => (h ? `${Math.round(h * 10) / 10}h` : '');
const span = (list) => {
  const due = list.map((r) => r.deadline).filter(Boolean).sort();
  if (!due.length) return '';
  return due[0] === due[due.length - 1] ? formatDate(due[0], 'day') : `${formatDate(due[0], 'day')} – ${formatDate(due[due.length - 1], 'day')}`;
};

/** The list in groups: project, then (optionally) phase, each foldable. */
function groupedTable(list, root) {
  const table = el('table', { class: 'sc-table alltasks at-grouped' },
    el('thead', {}, el('tr', {},
      el('th', { text: 'Name' }), el('th', { text: 'Assignee' }), el('th', { class: 'num', text: 'Hours' }),
      el('th', { text: 'Deadline' }), el('th', { class: 'num', text: 'Done' }), el('th', { text: '' }))));
  const body = el('tbody');
  const byPlan = new Map();
  for (const r of list) { if (!byPlan.has(r.planId)) byPlan.set(r.planId, []); byPlan.get(r.planId).push(r); }
  const head = (key, level, label, items, { active = false, planId, phaseId } = {}) => {
    const shut = folded.has(key);
    const done = items.length ? Math.round(items.reduce((n, r) => n + r.percent, 0) / items.length) : 0;
    body.append(el('tr', { class: `at-group-row level-${level}`, onclick: () => { if (shut) folded.delete(key); else folded.add(key); renderAllTasks(root); } },
      el('td', {},
        el('span', { class: 'at-twist', text: shut ? '▸' : '▾' }),
        el('span', { class: 'at-group-name', text: label }),
        active ? el('span', { class: 'sc-pill at-active', text: 'Active' }) : null,
        el('span', { class: 'sc-faint at-count', text: String(items.length) })),
      el('td', {}),
      el('td', { class: 'num sc-mono', text: hrs(items.reduce((n, r) => n + (r.percent < 100 ? r.hours : 0), 0)) }),
      el('td', { class: 'sc-mono sc-muted', text: span(items) }),
      el('td', { class: 'num' }, el('span', { class: 'sc-meter at-meter' }, el('span', { style: { '--value': `${done}%` } }))),
      el('td', {}, planId ? el('button', {
        class: 'sc-button sc-button--ghost sc-button--sm', text: '+ Task', title: 'Add a task here',
        onclick: (e) => { e.stopPropagation(); void addTo(planId, phaseId || null); },
      }) : null)));
    return shut;
  };
  const row = (r, level) => body.append(el('tr', { class: `clickable at-task level-${level}${r.percent === 100 ? ' is-done' : ''}`, onclick: () => { void openRow(r); } },
    el('td', {}, el('span', { class: `at-name${r.milestone ? ' is-milestone' : ''}`, text: r.name }),
      r.archived ? el('span', { class: 'sc-pill', text: 'Archived' }) : null),
    el('td', { text: r.who }),
    el('td', { class: 'num sc-mono', text: r.percent < 100 ? hrs(r.hours) : '' }),
    el('td', { class: `sc-mono${r.deadlineMissed ? ' warn' : ' sc-muted'}`, text: r.deadline ? formatDate(r.deadline, 'day') : '' }),
    el('td', { class: 'num', text: `${r.percent}%` }),
    el('td', {},
      r.late ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-warning)' }, text: 'Late' }) : null,
      r.critical ? el('span', { class: 'sc-pill', style: { '--tint': 'var(--sc-danger)' }, text: 'Critical' }) : null)));

  for (const [planId, items] of [...byPlan].sort((a, b) => a[1][0].planName.localeCompare(b[1][0].planName))) {
    if (head(`p|${planId}`, 0, items[0].planName, items, { planId })) continue;
    const ordered = [...items].sort((a, b) => a.order - b.order);
    if (grouping === 'project') { for (const r of ordered) row(r, 1); continue; }
    const byPhase = new Map();
    for (const r of ordered) { const k = r.phaseId || ''; if (!byPhase.has(k)) byPhase.set(k, []); byPhase.get(k).push(r); }
    for (const [phaseId, group] of [...byPhase].sort((a, b) => a[1][0].phaseOrder - b[1][0].phaseOrder)) {
      if (head(`f|${planId}|${phaseId}`, 1, phaseId ? group[0].phaseName : 'No phase', group, { active: group[0].activePhase, planId, phaseId })) continue;
      for (const r of group) row(r, 2);
    }
  }
  table.append(body);
  return table;
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

  pane.querySelector('.alltasks-head').prepend(el('select', {
    class: 'sc-select at-group', title: 'Group the list',
    onchange: (e) => { grouping = e.target.value; renderAllTasks(root); },
  }, ...Object.entries(GROUPS).map(([id, label]) => el('option', { value: id, text: `Group: ${label}`, selected: grouping === id }))));

  if (grouping !== 'none') { pane.append(groupedTable(list, root)); pane.append(el('p', { class: 'sc-faint small projects-note', text: `${list.length} of ${rows.length} tasks, across ${new Set(rows.map((r) => r.planId)).size} plans` })); return; }

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
