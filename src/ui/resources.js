// Resource Sheet (edit the people and things) and Resource Usage (hours per week).

import { el, clear, formatMoney, formatHours } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { RESOURCE_TYPES, identityOf } from '../model/model.js';
import { resourceLoad, computeSchedule } from '../model/schedule.js';
import { weekStart, fromDay, toDay, today, formatDate, makeCalendar, weekday, WEEKDAY_NAMES } from '../model/calendar.js';
import { planRecords, isCurrentWork } from '../state/sync.js';
import { parse } from '../io/json.js';
import { renderGrid } from './grid.js';
import { showMenu } from './dialog.js';

export const RESOURCE_COLUMNS = [
  { key: 'id', label: '#', width: 40, align: 'right', readonly: true },
  { key: 'ind', label: '', width: 34, readonly: true },
  { key: 'name', label: 'Resource Name', width: 200, edit: 'text' },
  { key: 'initials', label: 'Initials', width: 70, edit: 'text' },
  { key: 'type', label: 'Type', width: 90, edit: 'select', options: Object.entries(RESOURCE_TYPES).map(([value, label]) => ({ value, label })) },
  { key: 'maxUnits', label: 'Max Units', width: 84, edit: 'text', align: 'right' },
  { key: 'rate', label: 'Std Rate', width: 90, edit: 'text', align: 'right' },
  { key: 'group', label: 'Group', width: 160, edit: 'text' },
  { key: 'tasks', label: 'Tasks', width: 60, readonly: true, align: 'right' },
  { key: 'work', label: 'Work', width: 80, readonly: true, align: 'right' },
  { key: 'cost', label: 'Cost', width: 100, readonly: true, align: 'right' },
];
const editableKeys = RESOURCE_COLUMNS.filter((c) => c.edit).map((c) => c.key);

function resourceTotals() {
  const { project, schedule } = store;
  const totals = new Map(project.resources.map((r) => [r.id, { tasks: 0, work: 0, cost: 0 }]));
  for (const t of project.tasks) {
    const s = schedule.tasks[t.id];
    if (s.summary) continue;
    for (const a of t.assignments) {
      const r = project.resources.find((x) => x.id === a.resourceId);
      const tot = totals.get(a.resourceId);
      if (!r || !tot) continue;
      tot.tasks++;
      if (r.type === 'work') { const h = s.duration * project.calendar.hoursPerDay * a.units; tot.work += h; tot.cost += h * r.rate; }
      else if (r.type === 'material') tot.cost += a.units * r.rate;
      else tot.cost += a.units;
    }
  }
  return totals;
}

export function renderResourceSheet(root) {
  const { project, ui, issues } = store;
  clear(root);
  const pane = el('div', { class: 'sheet-pane' });
  root.append(pane);
  const totals = resourceTotals();
  const rows = project.resources.map((r, i) => {
    const over = issues.find((x) => x.code === 'overallocated' && x.resourceId === r.id);
    const t = totals.get(r.id);
    return {
      id: r.id, class: over ? 'is-over' : '',
      cells: {
        id: i + 1, ind: over ? el('span', { class: 'ind ind-warning', text: '⚠', title: over.text }) : '', name: r.name, initials: r.initials, type: RESOURCE_TYPES[r.type],
        maxUnits: r.type === 'work' ? `${Math.round(r.maxUnits * 100)}%` : '', rate: r.type === 'cost' ? '' : `${formatMoney(r.rate, project.currency)}${r.type === 'work' ? '/h' : ''}`, group: r.group,
        tasks: t.tasks || '', work: t.work ? formatHours(t.work) : '', cost: t.cost ? formatMoney(t.cost, project.currency) : '',
      },
      raw: { name: r.name, initials: r.initials, type: r.type, maxUnits: String(Math.round(r.maxUnits * 100)), rate: String(r.rate), group: r.group },
    };
  });
  const rowOf = (id) => rows.find((r) => r.id === id);
  renderGrid(pane, {
    columns: RESOURCE_COLUMNS, rows, selected: new Set(ui.resourceId ? [ui.resourceId] : []), activeId: ui.resourceId, activeCol: ui.activeCol,
    editing: ui.editing?.kind === 'resource' ? ui.editing : null,
    onSelect: (id) => set({ resourceId: id }),
    onCell: (id, col) => {
      if (ui.editing) return;
      if (ui.resourceId === id && ui.activeCol === col && editableKeys.includes(col)) set({ editing: { kind: 'resource', id, col } });
      else set({ activeCol: col });
    },
    onEdit: (id, col) => set({ resourceId: id, activeCol: col, editing: { kind: 'resource', id, col } }),
    onCommit: (id, col, value, { next }) => {
      const unchanged = String(value) === String(rowOf(id)?.raw[col] ?? '');
      if (!unchanged && !act.editResource(id, col, value)) { set({ editing: { kind: 'resource', id, col, seed: value } }); return; }
      set({ editing: null });
      const i = project.resources.findIndex((r) => r.id === id);
      if (next === 'down' && project.resources[i + 1]) set({ resourceId: project.resources[i + 1].id });
      else if (next === 'up' && project.resources[i - 1]) set({ resourceId: project.resources[i - 1].id });
      else if (next === 'right' || next === 'left') { const k = editableKeys[editableKeys.indexOf(col) + (next === 'right' ? 1 : -1)]; if (k) set({ activeCol: k }); }
    },
    onCancel: () => set({ editing: null }),
    onContext: (id, e) => {
      set({ resourceId: id });
      showMenu(e.clientX, e.clientY, [
        
        { label: 'New resource', run: act.newResource }, '-',
        { label: 'Delete resource', danger: true, run: () => act.deleteResource(id) },
      ]);
    },
    onAppend: act.newResource, appendLabel: '+ New resource',
  });
}

/**
 * Resource Usage: who is carrying what, across every project.
 *
 * A person works on several projects at once, so their load is only
 * meaningful when all of them are added up: forty hours in one plan and
 * thirty in another is not two comfortable weeks, it is one impossible one.
 * The rows are people, not a plan's resources, matched the way the calendar
 * matches them — the shared directory first, then the name.
 *
 * By day or by week, because those answer different questions: a week says
 * whether the month is deliverable, a day says whether tomorrow is.
 */

/** Which plans feed the view, read once and kept until their records change. */
const usageCache = new Map();
let usagePlans = [];
let usageLoaded = false;

export async function reloadUsage() {
  try {
    const out = [];
    for (const r of await planRecords()) {
      const hit = usageCache.get(r.id);
      if (hit && hit.updatedAt === r.updatedAt) { if (isCurrentWork(hit.entry.project)) out.push(hit.entry); continue; }
      try {
        const project = parse(r.body).project;
        const entry = { project, schedule: computeSchedule(project) };
        usageCache.set(r.id, { updatedAt: r.updatedAt, entry });
        if (isCurrentWork(project)) out.push(entry);
      } catch { /* a plan that cannot be read carries no load */ }
    }
    usagePlans = out;
  } catch {
    usagePlans = [];
  }
  usageLoaded = true;
  set({});
}

/** Columns: a run of days, or of weeks, from where the view is anchored. */
const USAGE_SPANS = { day: { label: 'By day', count: 21, step: 1 }, week: { label: 'By week', count: 12, step: 7 } };
let usageAnchor = null;
/** What is folded away. People are open by default, projects folded. */
const collapsedPeople = new Set();
const openPlans = new Set();
function toggle(set_, key, openByDefault = false) {
  if (openByDefault) { if (set_.has(key)) set_.delete(key); else set_.add(key); }
  else if (set_.has(key)) set_.delete(key); else set_.add(key);
  set({});
}
export const usageGrain = () => (USAGE_SPANS[store.ui.usageGrain] ? store.ui.usageGrain : 'week');
export function usageShift(steps) {
  const g = USAGE_SPANS[usageGrain()];
  usageAnchor = (usageAnchor ?? toDay(today())) + steps * g.step * Math.max(1, Math.round(g.count / 2));
  set({});
}
export function usageToday() { usageAnchor = null; set({}); }

/**
 * Resource Usage. Under the open project (Microsoft Project view) it is that
 * project's people and work, with the other projects one choice away; as the
 * Workload view of Projects & Tasks (`{ all: true }`) it is everyone, across
 * every project.
 */
export function renderResourceUsage(root, { all = false } = {}) {
  const { project, schedule, ui } = store;
  clear(root);
  const pane = el('div', { class: 'sheet-pane usage-pane' });
  root.append(pane);
  if (!usageLoaded) void reloadUsage();

  // The open plan comes from the store — it is newer than its record — and
  // every other plan from the shelf, as the calendar does it.
  const entries = [{ project, schedule }, ...usagePlans.filter((e) => e.project.id !== project.id)];
  const wide = all || ui.usageScope === 'all';
  const scope = wide ? entries : entries.slice(0, 1);

  const grain = usageGrain();
  const span = USAGE_SPANS[grain];
  const start = grain === 'week' ? weekStart(usageAnchor ?? toDay(today())) : (usageAnchor ?? toDay(today()));
  const columns = [];
  for (let i = 0; i < span.count; i++) columns.push(start + i * span.step);

  // people → { name, total, perColumn, tasks: [{plan, task, hours per column}] }
  const cal = makeCalendar(project.calendar);
  const people = new Map();
  const keyFor = (r) => identityOf(r);
  for (const { project: pr, schedule: sc } of scope) {
    const load = resourceLoad(pr, sc);
    for (const r of pr.resources) {
      if (r.type !== 'work') continue;
      const key = keyFor(r);
      if (!people.has(key)) people.set(key, { name: r.name, key, byDay: new Map(), total: 0, plans: new Map() });
      const person = people.get(key);
      const days = load.get(r.id);
      if (!days) continue;
      for (const [day, items] of days) {
        for (const it of items) {
          person.byDay.set(day, (person.byDay.get(day) || 0) + it.hours);
          person.total += it.hours;
          const t = pr.tasks.find((x) => x.id === it.taskId);
          if (!t) continue;
          // A person's hours break down by project first, then by task: the
          // question under "am I overloaded" is always "with what".
          if (!person.plans.has(pr.id)) person.plans.set(pr.id, { planId: pr.id, name: pr.name, byDay: new Map(), total: 0, tasks: new Map() });
          const plan = person.plans.get(pr.id);
          plan.byDay.set(day, (plan.byDay.get(day) || 0) + it.hours);
          plan.total += it.hours;
          if (!plan.tasks.has(t.id)) plan.tasks.set(t.id, { name: t.name, planName: pr.name, planId: pr.id, taskId: t.id, byDay: new Map(), total: 0 });
          const row = plan.tasks.get(t.id);
          row.byDay.set(day, (row.byDay.get(day) || 0) + it.hours);
          row.total += it.hours;
        }
      }
    }
  }

  const bucket = (byDay, at) => {
    let h = 0;
    for (let d = at; d < at + span.step; d++) h += byDay.get(d) || 0;
    return h;
  };
  // What a person can do in a column: the working days it holds.
  const capacityOf = (at) => {
    let days = 0;
    for (let d = at; d < at + span.step; d++) if (cal.isWorking(d)) days++;
    return days * cal.hoursPerDay;
  };

  const bar = el('div', { class: 'cal-phase usage-bar' },
    el('span', { class: 'sc-label', text: 'Usage' }),
    el('select', { class: 'sc-select', onchange: (e) => set({ usageGrain: e.target.value }) },
      ...Object.entries(USAGE_SPANS).map(([id, g]) => el('option', { value: id, text: g.label, selected: grain === id }))),
    all ? null : el('select', { class: 'sc-select', onchange: (e) => set({ usageScope: e.target.value }) },
      el('option', { value: 'plan', text: `This project — ${project.name}`, selected: !wide }),
      el('option', { value: 'all', text: `All projects (${entries.length})`, selected: wide })),
    el('button', { class: 'sc-button sc-button--sm', text: '‹', title: 'Earlier', onclick: () => usageShift(-1) }),
    el('button', { class: 'sc-button sc-button--sm', text: 'Today', onclick: usageToday }),
    el('button', { class: 'sc-button sc-button--sm', text: '›', title: 'Later', onclick: () => usageShift(1) }),
    el('span', { class: 'sc-faint small', text: `Hours per person, ${grain === 'week' ? 'by week' : 'by day'}, across ${scope.length === 1 ? 'this project' : `${scope.length} projects`}. Over ${formatHours(capacityOf(start))} in a ${grain} is marked.` }));
  pane.append(bar);

  if (!people.size) {
    pane.append(el('div', { class: 'empty-note sc-muted', text: 'Nobody is assigned to anything yet. Put people on tasks and their hours show up here.' }));
    return;
  }

  const todayDay = toDay(today());
  const head = el('tr', {}, el('th', { text: 'Person / Task' }), el('th', { class: 'num', text: 'Work' }));
  for (const at of columns) {
    head.append(el('th', {
      class: `num week${grain === 'day' && at === todayDay ? ' is-today' : ''}${grain === 'day' && !cal.isWorking(at) ? ' is-off' : ''}`,
      title: grain === 'week' ? `Week of ${formatDate(fromDay(at), 'long')}` : formatDate(fromDay(at), 'long'),
      text: grain === 'week' ? formatDate(fromDay(at), 'day') : `${WEEKDAY_NAMES[weekday(at)].slice(0, 1)} ${fromDay(at).slice(8)}`,
    }));
  }
  const table = el('table', { class: 'grid usage' });
  table.append(el('thead', {}, head));
  const body = el('tbody');

  const cells = (byDay, { cap = false } = {}) => columns.map((at) => {
    const h = bucket(byDay, at);
    const room = capacityOf(at);
    return el('td', {
      class: `num${cap && h > room + 1e-9 ? ' is-over' : ''}`,
      title: cap && h ? `${formatHours(h)} of ${formatHours(room)}` : '',
      text: h ? formatHours(h) : '',
    });
  });

  for (const person of [...people.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const shut = collapsedPeople.has(person.key);
    body.append(el('tr', { class: 'is-summary usage-row', onpointerdown: () => toggle(collapsedPeople, person.key) },
      el('td', {}, el('span', { class: 'usage-twist', text: shut ? '▸' : '▾' }), el('span', { class: 'cell-text', text: person.name })),
      el('td', { class: 'num', text: formatHours(person.total) }),
      ...cells(person.byDay, { cap: true })));
    if (shut) continue;

    for (const plan of [...person.plans.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!columns.some((at) => bucket(plan.byDay, at) > 0)) continue;
      const planKey = `${person.key}|${plan.planId}`;
      const planShut = !openPlans.has(planKey);           // projects start folded
      body.append(el('tr', { class: 'usage-plan-row usage-row', onpointerdown: () => toggle(openPlans, planKey, true) },
        el('td', { style: { paddingLeft: '20px' } },
          el('span', { class: 'usage-twist', text: planShut ? '▸' : '▾' }),
          el('span', { class: 'cell-text', text: plan.name })),
        el('td', { class: 'num', text: formatHours(plan.total) }),
        ...cells(plan.byDay)));
      if (planShut) continue;

      for (const row of [...plan.tasks.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        if (!columns.some((at) => bucket(row.byDay, at) > 0)) continue;
        const foreign = row.planId !== project.id;
        body.append(el('tr', {
          class: ui.selection.includes(row.taskId) && !foreign ? 'is-sel' : '',
          onpointerdown: () => { if (!foreign) act.selectTask(row.taskId); },
          ondblclick: () => { if (foreign) void openUsagePlan(row.planId, row.taskId); },
          title: foreign ? `${row.planName} — double-click to open it` : row.planName,
        },
          el('td', { style: { paddingLeft: '44px' } }, el('span', { class: 'cell-text', text: row.name })),
          el('td', { class: 'num', text: formatHours(row.total) }),
          ...cells(row.byDay)));
      }
    }
  }
  table.append(body);
  pane.append(table);
}

/** A row from another plan: open that plan, and land on the task. */
async function openUsagePlan(planId, taskId) {
  const { openPlan } = await import('../state/sync.js');
  if (!(await openPlan(planId))) return;
  act.revealTask(taskId);
  act.selectTask(taskId);
  void import('./blockmenu.js').then((m) => m.taskSheet({ taskId }));
}
