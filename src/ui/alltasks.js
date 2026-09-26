// Task lists, as Motion's Projects & Tasks and a project's own views are.
//
// A page of saved views, each a tab: its layout (List, Kanban, Gantt or
// Workload), what it groups by — any number of nested levels, in an order you
// drag — the order of the groups at each level (dragged, or moved with
// ⤒ ↑ ↓ ⤓), how tasks are sorted inside a group, its filters, and its
// columns. Changing a view marks its tab with * until the change is saved or
// discarded. Tabs drag into a new order; the ✎ button lists the views to
// search, reorder, rename, duplicate or delete; ＋ makes a new one.
//
// Two places have views: Projects & Tasks, over every project (kept on this
// device), and each project's Task list, over its own tasks (kept in the
// project, so they travel with it).
//
// Every plan on the shelf is read, not only the open one. Each is parsed and
// scheduled once and kept until its record changes, because doing that for
// twenty plans on every keystroke in the search box would be waste.

import { el, clear } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { planRecords, openPlan, listWorkspaces } from '../state/sync.js';
import { currentLayout } from './calendar.js';
import { parse } from '../io/json.js';
import { computeSchedule } from '../model/schedule.js';
import { isSummary, phaseOf, getPhase, phases, stageOf, stages, urgencyOf, URGENCIES } from '../model/model.js';
import { hoursLeft, expectedHours, agendaOf } from '../model/agenda.js';
import { stageColour } from '../model/stages.js';
import { formatDate, toDay, fromDay, today, weekStart, monthStart, addMonths, MONTH_NAMES, WEEKDAY_NAMES, weekday } from '../model/calendar.js';
import { orderable } from './orderable.js';
import { icon, projectColour } from './icons.js';
import { showMenu, promptText, confirmDialog, open as openDialog, foot, button } from './dialog.js';
import { renderResourceUsage } from './resources.js';

/** planId → { updatedAt, plan, rows }. */
const cache = new Map();
let rows = [];
let plans = [];
let spaces = [];
let loading = false;
let loaded = false;

const minText = (m) => (!m ? '' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`);
const shortDate = (iso) => (iso ? `${WEEKDAY_NAMES[weekday(toDay(iso))].slice(0, 3)} ${formatDate(iso, 'day')}` : '');
const weekLabel = (k) => `${formatDate(k, 'day')} – ${formatDate(fromDay(toDay(k) + 6), 'day')}`;
const clone = (x) => JSON.parse(JSON.stringify(x));
const FLAG = { now: 'var(--sc-danger)', high: '#e0703a', normal: '#d9a52b', low: 'var(--sc-text-3)' };

function readPlan(record) {
  const hit = cache.get(record.id);
  if (hit && hit.updatedAt === record.updatedAt) return hit;
  let entry = { updatedAt: record.updatedAt, plan: null, rows: [] };
  try {
    const project = parse(record.body).project;
    if (project.template) { cache.set(record.id, entry); return entry; }
    const schedule = computeSchedule(project);
    const todayDay = toDay(today());
    const current = getPhase(project, project.currentPhaseId);
    const out = [];
    project.tasks.forEach((t, i) => {
      if (isSummary(project, i)) return;
      const s = schedule.tasks[t.id];
      const phaseId = phaseOf(project, t.id);
      const ph = phaseId ? getPhase(project, phaseId) : null;
      const exp = Math.round(expectedHours(project, s, t) * 60);
      const left = Math.round(hoursLeft(project, s, t) * 60);
      const who = t.assignments.map((a) => project.resources.find((r) => r.id === a.resourceId)?.name).filter(Boolean);
      const status = stageOf(project, t);
      out.push({
        planId: record.id, planName: project.name || record.name, workspaceId: project.workspaceId || '', taskId: t.id,
        phaseId, phaseName: ph?.name || null, phaseColour: ph ? stageColour(project, ph) : null, phaseOrder: ph ? phases(project).indexOf(ph) : -1,
        phaseDeadline: ph?.deadline || null, activePhase: !!ph && project.currentPhaseId === ph.id,
        order: i, name: t.name, deadline: t.deadline, start: s.startIso, percent: s.percent, milestone: s.milestone,
        who, expected: exp, done: Math.max(0, exp - left),
        doneAt: t.doneAt || null, archived: !!t.archived, cancelled: !!status.cancelled || !!t.archived,
        status: status.name, urgency: urgencyOf(t), auto: agendaOf(project, t).show, labels: t.labels || [],
        pastDeadline: !!t.deadline && s.percent < 100 && toDay(t.deadline) < todayDay,
        planArchived: !!project.archived,
      });
    });
    entry = {
      updatedAt: record.updatedAt, rows: out,
      plan: {
        id: record.id, name: project.name, workspaceId: project.workspaceId || '', archived: !!project.archived,
        start: schedule.startIso, finish: project.deadline || schedule.finishIso, deadline: project.deadline || null,
        stageName: current?.name || null, stageColour: current ? stageColour(project, current) : null,
        colour: project.colour, status: project.status || (project.archived ? 'Completed' : 'Todo'), tasks: out.length,
        stageList: phases(project).map((ph) => ({ id: ph.id, name: ph.name, colour: stageColour(project, ph) })),
        statusList: stages(project).map((st) => ({ id: st.id, name: st.name })),
      },
    };
  } catch { /* an unreadable plan adds nothing */ }
  cache.set(record.id, entry);
  return entry;
}

export async function reloadAllTasks() {
  loading = true;
  set({});
  try {
    const records = await planRecords();
    spaces = await listWorkspaces().catch(() => []);
    const entries = records.map(readPlan).filter((e) => e.plan);
    plans = entries.map((e) => e.plan);
    rows = entries.flatMap((e) => e.rows);
  } catch { rows = []; plans = []; }
  loading = false;
  loaded = true;
  set({});
}

/** ETA: the last day the calendar has work for a task, from its own layout. */
function etaOf(r, layout) {
  const blocks = layout?.all?.byTask?.get(r.taskId)?.filter((b) => b.planId === r.planId && !b.worked) || [];
  return blocks.length ? fromDay(Math.max(...blocks.map((b) => b.day))) : null;
}

async function openRow(r) {
  const { taskSheet } = await import('./blockmenu.js');
  await taskSheet({ planId: r.planId, taskId: r.taskId });
  void reloadAllTasks();
}
/** A new task in a project, in a stage and a status if the group says so, opened at once. */
async function addTo({ planId, phaseId = null, statusId = null }) {
  if (planId !== store.project.id && !(await openPlan(planId))) return;
  const made = act.newTaskInPhase(phaseId || null);
  if (made && statusId) act.setTaskStage(made.id, statusId);
  if (made) { const { taskSheet } = await import('./blockmenu.js'); await taskSheet({ planId, taskId: made.id }); }
  void reloadAllTasks();
}
const wsName = (id) => (id ? spaces.find((w) => w.id === id)?.name || 'Workspace' : 'No workspace');
const planOf = (id) => plans.find((p) => p.id === id);

// ------------------------------------------------------------------ fields

/** What tasks can be grouped by. */
const FIELDS = {
  workspace: 'Workspace', project: 'Project', stage: 'Stage', status: 'Status', priority: 'Priority',
  assignee: 'Assignee', deadline: 'Deadline (week)', start: 'Start date (week)', label: 'Label',
};
/** Columns of the List, after the name. */
const COLUMNS = {
  eta: 'ETA', assignee: 'Assignee', project: 'Project', status: 'Status', stage: 'Stage', priority: 'Priority',
  start: 'Start date', deadline: 'Deadline', duration: 'Duration', completed: 'Completed', completedAt: 'Completed at', labels: 'Labels',
};
const ALL_COLUMNS = ['eta', 'assignee', 'project', 'completedAt', 'duration', 'deadline', 'completed'];
const PROJECT_COLUMNS = ['eta', 'deadline', 'status', 'stage', 'priority', 'completed', 'duration'];
/** What tasks can be sorted by, inside a group. */
const SORTS = {
  name: 'Name', deadline: 'Deadline', start: 'Start date', priority: 'Priority', status: 'Status',
  duration: 'Duration', eta: 'ETA', completedAt: 'Completed at', project: 'Project',
};
/** Workload is the Resource Usage view: each person's hours a day against what they have. */
const LAYOUTS = { list: ['☰', 'List'], kanban: ['▥', 'Kanban'], gantt: ['▤', 'Gantt'], workload: ['◔', 'Workload'] };
const layoutsHere = () => Object.entries(LAYOUTS).filter(([k]) => scope === 'all' || k !== 'gantt');

// ------------------------------------------------------------------- views

let scope = 'all';              // 'all' — Projects & Tasks — or 'project' — the open plan's Task list
let lastRoot = null;
const page = { query: '', ganttFrom: null, ganttSpan: 'quarter' };
const folded = new Set();
const working = new Map();      // `${scopeKey}|${viewId}` → the view as edited, not yet saved
const scopeKey = () => (scope === 'project' ? `plan:${store.project.id}` : 'all');
const ALL_KEY = 'project-planner:views:all';
const ACTIVE_KEY = 'project-planner:view-active';
const readJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } };
const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } };
const newId = () => `v_${Math.random().toString(36).slice(2, 10)}`;

function normal(v) {
  return {
    id: v.id || newId(), name: v.name || 'View', layout: LAYOUTS[v.layout] ? v.layout : 'list',
    groups: Array.isArray(v.groups) ? v.groups.filter((g) => FIELDS[g]) : [],
    hideEmpty: v.hideEmpty !== false, groupOrder: v.groupOrder && typeof v.groupOrder === 'object' ? v.groupOrder : {},
    sort: Array.isArray(v.sort) ? v.sort.filter((s) => SORTS[s?.field]) : [],
    filters: v.filters && typeof v.filters === 'object' ? v.filters : {},
    pastOnly: !!v.pastOnly, resolved: !!v.resolved, completedProjects: !!v.completedProjects,
    columns: Array.isArray(v.columns) ? v.columns.filter((c) => COLUMNS[c]) : (scope === 'project' ? PROJECT_COLUMNS : ALL_COLUMNS),
  };
}

function defaultViews() {
  if (scope === 'project') {
    return [
      normal({ id: 'v_list', name: 'Task List', groups: ['stage'], columns: PROJECT_COLUMNS }),
      normal({ id: 'v_status', name: 'By status', groups: ['status'], columns: PROJECT_COLUMNS }),
    ];
  }
  // What the page was set to before it had views becomes its first view.
  const old = readJson('project-planner:tasklist', {});
  const legacy = { wps: ['workspace', 'project', 'stage'], ps: ['project', 'stage'], project: ['project'], assignee: ['assignee'], status: ['status'], deadline: ['deadline'], none: [] };
  return [
    normal({ id: 'v_tasks', name: 'Task List', layout: old.layout === 'kanban' ? 'kanban' : 'list', groups: legacy[old.group] || legacy.wps,
      pastOnly: !!old.pastOnly, resolved: !!old.resolved, filters: { workspace: old.workspace || '' }, columns: ALL_COLUMNS }),
    normal({ id: 'v_timelines', name: 'Project Timelines', layout: 'gantt', groups: ['workspace', 'stage'], completedProjects: !!old.completedProjects }),
    normal({ id: 'v_workload', name: 'Workload', layout: 'workload' }),
  ];
}
function savedViews() {
  const list = scope === 'project' ? store.project.views : readJson(ALL_KEY, null);
  return Array.isArray(list) && list.length ? list.map(normal) : defaultViews();
}
async function writeViews(list) {
  const clean = clone(list);
  if (scope === 'project') {
    const { patchPlan } = await import('../state/sync.js');
    await patchPlan(store.project.id, (p) => { p.views = clean; }, 'Views');
  } else writeJson(ALL_KEY, clean);
}
function activeId(list) {
  const id = readJson(ACTIVE_KEY, {})[scopeKey()];
  return list.some((v) => v.id === id) ? id : list[0].id;
}
function setActive(id) { writeJson(ACTIVE_KEY, { ...readJson(ACTIVE_KEY, {}), [scopeKey()]: id }); closePop(); redraw(); }
function current() {
  const list = savedViews();
  const base = list.find((v) => v.id === activeId(list)) || list[0];
  const w = working.get(`${scopeKey()}|${base.id}`);
  return { list, base, view: w || base, dirty: !!w && JSON.stringify(w) !== JSON.stringify(base) };
}
/** Change the view on screen; it is marked * until saved. */
function edit(change) {
  const { view, base } = current();
  const next = clone(view);
  change(next);
  working.set(`${scopeKey()}|${base.id}`, normal(next));
  redraw();
}
async function saveView() {
  const { list, view, base } = current();
  await writeViews(list.map((v) => (v.id === base.id ? view : v)));
  working.delete(`${scopeKey()}|${base.id}`);
  redraw();
}
function discardView() { working.delete(`${scopeKey()}|${current().base.id}`); redraw(); }

async function renameView(id) {
  const list = savedViews();
  const v = list.find((x) => x.id === id);
  const name = await promptText('Rename the view', '', v.name);
  if (!name?.trim()) return;
  await writeViews(list.map((x) => (x.id === id ? { ...x, name: name.trim() } : x)));
  const w = working.get(`${scopeKey()}|${id}`);
  if (w) w.name = name.trim();
  redraw();
}
async function duplicateView(id) {
  const list = savedViews();
  const i = list.findIndex((x) => x.id === id);
  const from = working.get(`${scopeKey()}|${id}`) || list[i];
  const copy = normal({ ...clone(from), id: newId(), name: `${from.name} (copy)` });
  await writeViews([...list.slice(0, i + 1), copy, ...list.slice(i + 1)]);
  setActive(copy.id);
}
async function deleteView(id) {
  const list = savedViews();
  if (list.length < 2) { act.hint('A page keeps at least one view.'); return; }
  const v = list.find((x) => x.id === id);
  if (!(await confirmDialog(`Delete the view “${v.name}”?`, 'Only the view goes — no task is touched.', 'Delete view'))) return;
  working.delete(`${scopeKey()}|${id}`);
  await writeViews(list.filter((x) => x.id !== id));
  redraw();
}
async function arrangeViews(ids) {
  const list = savedViews();
  await writeViews(ids.map((id) => list.find((v) => v.id === id)).filter(Boolean));
  redraw();
}
function copyViewLink(id) {
  const url = `${location.origin}${location.pathname}#view=${encodeURIComponent(scopeKey())}:${encodeURIComponent(id)}`;
  navigator.clipboard?.writeText(url).then(() => act.hint('Link copied.'), () => act.hint(url));
}

/** New View: its layout and its name, as Motion asks. */
async function newViewDialog() {
  const choice = await openDialog('New view', (close) => {
    let layout = 'list';
    const name = el('input', { class: 'sc-input', type: 'text', placeholder: 'View name', 'data-autofocus': '' });
    const kinds = el('div', { class: 'tl-kinds' });
    const draw = () => kinds.replaceChildren(...layoutsHere().map(([k, [glyph, label]]) => el('button', { class: `tl-kind${layout === k ? ' is-on' : ''}`, onclick: () => { layout = k; draw(); } },
      el('span', { class: 'tl-kind-glyph', text: glyph }), el('span', { text: label }))));
    draw();
    const save = () => { if (name.value.trim()) close({ layout, name: name.value.trim() }); else name.focus(); };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    close.onSave = save;
    return [kinds, name, foot(el('span', { class: 'sc-spacer' }), button('Cancel', () => close(null)), button('Save', save, 'sc-button--primary'))];
  });
  if (!choice) return;
  const { list, view } = current();
  const made = normal({ ...clone(view), id: newId(), name: choice.name, layout: choice.layout, groupOrder: {} });
  if (choice.layout === 'gantt') made.groups = ['workspace', 'stage'];
  await writeViews([...list, made]);
  setActive(made.id);
}

// ---------------------------------------------------------------- the rows

const inScopePlans = (view) => (scope === 'project'
  ? plans.filter((p) => p.id === store.project.id)
  : plans.filter((p) => !p.archived && (!view.filters.workspace || p.workspaceId === view.filters.workspace)));

/** The tasks the scope has, before the view's own filters. */
const scopeRows = (view) => rows.filter((r) => (scope === 'project'
  ? r.planId === store.project.id
  : !r.planArchived && (!view.filters.workspace || r.workspaceId === view.filters.workspace)));

function deadlineMatch(r, rule) {
  const todayDay = toDay(today());
  if (rule === 'none') return !r.deadline;
  if (!r.deadline) return false;
  const d = toDay(r.deadline);
  if (rule === 'overdue') return d < todayDay && r.percent < 100;
  if (rule === 'week') return weekStart(d) === weekStart(todayDay);
  if (rule === 'next7') return d >= todayDay && d < todayDay + 7;
  return true;
}

function visible(view, layout) {
  const f = view.filters;
  const q = page.query.trim().toLowerCase();
  return scopeRows(view).filter((r) => {
    if (!view.resolved && (r.percent === 100 || r.cancelled)) return false;
    if (view.pastOnly) { const eta = etaOf(r, layout); if (!(r.deadline && eta && eta > r.deadline)) return false; }
    if (f.status?.length && !f.status.includes(r.status)) return false;
    if (f.priority?.length && !f.priority.includes(r.urgency)) return false;
    if (f.assignee?.length && !f.assignee.includes(r.who[0] || '')) return false;
    if (f.project?.length && !f.project.includes(r.planId)) return false;
    if (f.label?.length && !r.labels.some((l) => f.label.includes(l))) return false;
    if (f.deadline && !deadlineMatch(r, f.deadline)) return false;
    return !q || `${r.name} ${r.planName} ${r.who.join(' ')} ${r.labels.join(' ')}`.toLowerCase().includes(q);
  });
}
const filterCount = (view) => ['status', 'priority', 'assignee', 'project', 'label'].filter((k) => view.filters[k]?.length).length
  + (view.filters.deadline ? 1 : 0) + (scope === 'all' && view.filters.workspace ? 1 : 0);

// ---------------------------------------------------------------- grouping

function keyOf(field, r) {
  switch (field) {
    case 'workspace': return r.workspaceId;
    case 'project': return r.planId;
    case 'stage': return r.phaseName || '';
    case 'status': return r.status;
    case 'priority': return r.urgency;
    case 'assignee': return r.who[0] || '';
    case 'deadline': return r.deadline ? fromDay(weekStart(toDay(r.deadline))) : '';
    case 'start': return r.start ? fromDay(weekStart(toDay(r.start))) : '';
    case 'label': return r.labels[0] || '';
    default: return '';
  }
}
function nameOf(field, k, sample) {
  switch (field) {
    case 'workspace': return wsName(k);
    case 'project': return planOf(k)?.name || sample?.planName || 'Project';
    case 'stage': return k || 'No Stage';
    case 'status': return k;
    case 'priority': return URGENCIES[k]?.label || k;
    case 'assignee': return k || 'Unassigned';
    case 'deadline': return k ? weekLabel(k) : 'No deadline';
    case 'start': return k ? weekLabel(k) : 'No start date';
    case 'label': return k || 'No label';
    default: return k;
  }
}
/** Every value a field can take in the scope, in its natural order — for groups with no tasks, and for ordering. */
function domainOf(field, view) {
  const ps = inScopePlans(view);
  const union = (lists) => [...new Set(lists.flat())];
  switch (field) {
    case 'status': return union(ps.map((p) => p.statusList.map((s) => s.name)));
    case 'priority': return Object.keys(URGENCIES);
    case 'stage': return union(ps.map((p) => p.stageList.map((s) => s.name)));
    case 'project': return ps.map((p) => p.id);
    case 'workspace': return scope === 'all' ? [...spaces.map((w) => w.id), ''] : [];
    default: return [];
  }
}
const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
function rankOf(field, k, view) {
  switch (field) {
    case 'workspace': return [k ? 0 : 1, wsName(k).toLowerCase()];
    case 'project': return [nameOf('project', k).toLowerCase()];
    case 'stage': case 'status': { const i = domainOf(field, view).indexOf(k); return [k ? 0 : 1, i < 0 ? 999 : i, k]; }
    case 'priority': return [URGENCIES[k]?.rank ?? 9];
    case 'deadline': case 'start': return [k || '9999'];
    default: return [k ? 0 : 1, String(k).toLowerCase()];
  }
}
/** A level's values: the natural order, then the order dragged by hand on top of it. */
function orderKeys(field, keys, view) {
  const manual = view.groupOrder[field] || [];
  const at = (k) => { const i = manual.indexOf(k); return i < 0 ? Infinity : i; };
  return [...keys].sort((a, b) => cmp(rankOf(field, a, view), rankOf(field, b, view))).sort((a, b) => at(a) - at(b));
}

/** [{ key, field, value, label, rows, sample, path, children }] — `path` is { field: value } down to here. */
function groupTree(list, view, fields = view.groups, level = 0, prefix = '', path = {}) {
  if (level >= fields.length) return null;
  const field = fields[level];
  const map = new Map();
  for (const r of list) { const k = keyOf(field, r); if (!map.has(k)) map.set(k, []); map.get(k).push(r); }
  if (!view.hideEmpty) for (const k of domainOf(field, view)) if (!map.has(k)) map.set(k, []);
  return orderKeys(field, [...map.keys()], view).map((k) => {
    const rs = map.get(k);
    const key = `${prefix}/${field}:${k}`;
    const here = { ...path, [field]: k };
    return { key, field, value: k, label: nameOf(field, k, rs[0]), rows: rs, sample: rs[0], path: here, children: groupTree(rs, view, fields, level + 1, key, here) };
  });
}

/** Where a new task made in a group goes: its project, and its stage and status when the group names them. */
function targetOf(path, rs) {
  let planId = scope === 'project' ? store.project.id : path.project || null;
  if (!planId && rs.length && rs.every((r) => r.planId === rs[0].planId)) planId = rs[0].planId;
  if (!planId) return null;
  const p = planOf(planId);
  const phaseId = path.stage ? p?.stageList.find((s) => s.name === path.stage)?.id || null : null;
  const statusId = path.status ? p?.statusList.find((s) => s.name === path.status)?.id || null : null;
  return { planId, phaseId, statusId };
}

function sortRows(list, view, layout) {
  if (!view.sort.length) return [...list].sort((a, b) => (a.planId === b.planId ? a.order - b.order : a.planName.localeCompare(b.planName)));
  const statusIdx = (r) => { const i = domainOf('status', view).indexOf(r.status); return i < 0 ? 999 : i; };
  const value = {
    name: (r) => r.name.toLowerCase(), deadline: (r) => r.deadline || '9999', start: (r) => r.start || '9999',
    priority: (r) => URGENCIES[r.urgency]?.rank ?? 9, status: statusIdx, duration: (r) => r.expected,
    eta: (r) => etaOf(r, layout) || '9999', completedAt: (r) => r.doneAt || '', project: (r) => r.planName.toLowerCase(),
  };
  return [...list].sort((a, b) => {
    for (const s of view.sort) {
      const x = value[s.field](a);
      const y = value[s.field](b);
      if (x !== y) return (x < y ? -1 : 1) * (s.dir === 'desc' ? -1 : 1);
    }
    return a.order - b.order;
  });
}

/** A group value as it is drawn in a header or a Sort Groups list. */
function valueNode(field, k, label, sample) {
  const text = el('span', { class: 'tl-value-name', text: label });
  switch (field) {
    case 'workspace': return el('span', { class: 'tl-value' }, icon('workspace'), text);
    case 'project': return el('span', { class: 'tl-value' }, icon('project', projectColour(planOf(k)?.colour)), text);
    case 'stage': {
      const colour = sample?.phaseColour || plans.flatMap((p) => p.stageList).find((s) => s.name === k)?.colour;
      return k ? el('span', { class: 'ps-chip', style: { '--st': colour }, text: label }) : el('span', { class: 'ps-chip is-none', text: label });
    }
    case 'status': return el('span', { class: 'tl-value' }, el('span', { class: `tl-ring${/complete/i.test(k) ? ' is-done' : ''}` }), text);
    case 'priority': return el('span', { class: 'tl-value' }, el('span', { style: { color: FLAG[k] }, text: '⚑' }), text);
    case 'assignee': return el('span', { class: 'tl-value' }, el('span', { class: 'tl-avatar', text: (k || '?')[0] }), text);
    default: return el('span', { class: 'tl-value' }, text);
  }
}

// ------------------------------------------------------------------ popovers

let pop = null;   // { kind, node, search? }
function onOutside(e) { if (pop && !pop.node.contains(e.target) && !e.target.closest?.('.pop-menu, .tl-pop-btn, .sc-dialog, dialog')) closePop(); }
function onEsc(e) { if (e.key === 'Escape' && pop) { e.stopPropagation(); closePop(); } }
function closePop() {
  if (!pop) return;
  pop.node.remove();
  pop = null;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onEsc, true);
  for (const b of document.querySelectorAll('.tl-pop-btn.is-open')) b.classList.remove('is-open');
}
function togglePop(kind, anchor) {
  if (pop?.kind === kind) { closePop(); return; }
  closePop();
  const node = el('div', { class: `tl-pop tl-pop-${kind}` });
  const r = anchor.getBoundingClientRect();
  node.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 520))}px`;
  node.style.top = `${r.bottom + 6}px`;
  document.body.append(node);
  pop = { kind, node };
  anchor.classList.add('is-open');
  drawPop();
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onEsc, true);
}
function drawPop() {
  if (!pop) return;
  const content = PANELS[pop.kind]?.();
  if (!content) { closePop(); return; }
  pop.node.replaceChildren(...content.filter(Boolean));
}
const popHead = (title, ...extra) => el('div', { class: 'tl-pop-head' }, el('strong', { text: title }), el('span', { class: 'sc-spacer' }), ...extra);
const linkButton = (text, run, title = '') => el('button', { class: 'tl-link', text, title, onclick: run });
const fieldsFor = () => Object.entries(FIELDS).filter(([k]) => scope === 'all' || k !== 'workspace');

const PANELS = {
  /** Group by: the levels, dragged into order; each a choice of field. */
  group() {
    const { view } = current();
    const used = view.groups;
    const free = fieldsFor().filter(([k]) => !used.includes(k));
    const level = (f, i) => el('div', { class: 'tl-level' },
      el('select', { class: 'sc-select sc-select--sm', onchange: (e) => edit((x) => { x.groups[i] = e.target.value; }) },
        ...fieldsFor().filter(([k]) => k === f || !used.includes(k)).map(([k, label]) => el('option', { value: k, text: label, selected: k === f }))),
      el('button', { class: 'ord-btn', text: '×', title: 'Remove this level', onclick: () => edit((x) => { x.groups.splice(i, 1); }) }));
    return [
      popHead('Groups', linkButton('Reset', () => edit((x) => { x.groups = defaultViews()[0].groups; x.groupOrder = {}; }))),
      used.length ? orderable(used.map((f, i) => ({ key: f, node: level(f, i) })), (keys) => edit((x) => { x.groups = keys; }), { buttons: false })
        : el('p', { class: 'sc-faint small tl-pop-note', text: 'No grouping: one list of tasks.' }),
      free.length ? linkButton(used.length ? '＋ Add nested row' : '＋ Add a group', () => edit((x) => { x.groups.push(free[0][0]); })) : null,
      el('label', { class: 'tl-toggle' }, el('span', { text: 'Hide empty groups' }),
        el('input', { type: 'checkbox', class: 'sc-check', checked: view.hideEmpty, onchange: (e) => edit((x) => { x.hideEmpty = e.target.checked; }) })),
    ];
  },

  /** Sort Groups: a column for each level, its values dragged (or moved) into order. */
  sortGroups() {
    const { view } = current();
    if (!view.groups.length) return [popHead('Sort groups'), el('p', { class: 'sc-faint small tl-pop-note', text: 'Group by something first: then its groups can be put in any order here.' })];
    const list = scopeRows(view);
    return [el('div', { class: 'tl-sg' }, ...view.groups.map((field) => {
      const keys = new Set(list.map((r) => keyOf(field, r)));
      for (const k of domainOf(field, view)) keys.add(k);
      const sample = new Map();
      for (const r of list) { const k = keyOf(field, r); if (!sample.has(k)) sample.set(k, r); }
      const ordered = orderKeys(field, [...keys], view);
      return el('div', { class: 'tl-sg-col' },
        popHead(FIELDS[field], view.groupOrder[field]
          ? el('button', { class: 'ord-btn', text: '↺', title: 'Back to the natural order', onclick: () => edit((x) => { delete x.groupOrder[field]; }) }) : null),
        orderable(ordered.map((k) => ({ key: k, node: valueNode(field, k, nameOf(field, k, sample.get(k)), sample.get(k)) })),
          (order) => edit((x) => { x.groupOrder = { ...x.groupOrder, [field]: order }; })));
    }))];
  },

  /** Sort Tasks: inside each group, by these, in this order. */
  sortTasks() {
    const { view } = current();
    const used = view.sort.map((s) => s.field);
    const free = Object.keys(SORTS).filter((k) => !used.includes(k));
    const line = (s, i) => el('div', { class: 'tl-level' },
      el('select', { class: 'sc-select sc-select--sm', onchange: (e) => edit((x) => { x.sort[i].field = e.target.value; }) },
        ...Object.entries(SORTS).filter(([k]) => k === s.field || !used.includes(k)).map(([k, label]) => el('option', { value: k, text: label, selected: k === s.field }))),
      el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: s.dir === 'desc' ? '↓ Descending' : '↑ Ascending',
        onclick: () => edit((x) => { x.sort[i].dir = s.dir === 'desc' ? 'asc' : 'desc'; }) }),
      el('button', { class: 'ord-btn', text: '×', title: 'Remove', onclick: () => edit((x) => { x.sort.splice(i, 1); }) }));
    return [
      popHead('Sort tasks', view.sort.length ? linkButton('Reset', () => edit((x) => { x.sort = []; })) : null),
      view.sort.length ? orderable(view.sort.map((s, i) => ({ key: s.field, node: line(s, i) })), (keys) => edit((x) => { x.sort = keys.map((k) => x.sort.find((s) => s.field === k)); }), { buttons: false })
        : el('p', { class: 'sc-faint small tl-pop-note', text: 'Tasks keep the order they have in their project.' }),
      free.length ? linkButton('＋ Add sort', () => edit((x) => { x.sort.push({ field: free[0], dir: 'asc' }); })) : null,
    ];
  },

  /** Filters: which tasks the view shows. */
  filters() {
    const { view } = current();
    const list = scopeRows(view);
    const chips = (title, key, options) => (options.length ? el('div', { class: 'tl-f' },
      el('div', { class: 'tl-f-title sc-faint small', text: title }),
      el('div', { class: 'tl-f-chips' }, ...options.map(([value, label]) => el('button', {
        class: `tl-chip${view.filters[key]?.includes(value) ? ' is-on' : ''}`, text: label,
        onclick: () => edit((x) => {
          const on = new Set(x.filters[key] || []);
          if (on.has(value)) on.delete(value); else on.add(value);
          x.filters = { ...x.filters, [key]: [...on] };
        }),
      })))) : null);
    const uniq = (xs) => [...new Set(xs)];
    return [
      popHead('Filters', filterCount(view) ? linkButton('Clear all', () => edit((x) => { x.filters = {}; })) : null),
      scope === 'all' ? el('div', { class: 'tl-f' }, el('div', { class: 'tl-f-title sc-faint small', text: 'Workspace' }),
        el('select', { class: 'sc-select sc-select--sm', onchange: (e) => edit((x) => { x.filters = { ...x.filters, workspace: e.target.value }; }) },
          el('option', { value: '', text: 'All workspaces' }), ...spaces.map((w) => el('option', { value: w.id, text: w.name, selected: view.filters.workspace === w.id })))) : null,
      chips('Status', 'status', domainOf('status', view).map((s) => [s, s])),
      chips('Priority', 'priority', Object.entries(URGENCIES).map(([k, u]) => [k, u.label])),
      chips('Assignee', 'assignee', uniq(list.map((r) => r.who[0] || '')).sort().map((a) => [a, a || 'Unassigned'])),
      scope === 'all' ? chips('Project', 'project', inScopePlans(view).map((p) => [p.id, p.name]).sort((a, b) => a[1].localeCompare(b[1]))) : null,
      chips('Label', 'label', uniq(list.flatMap((r) => r.labels)).sort().map((l) => [l, l])),
      el('div', { class: 'tl-f' }, el('div', { class: 'tl-f-title sc-faint small', text: 'Deadline' }),
        el('select', { class: 'sc-select sc-select--sm', onchange: (e) => edit((x) => { x.filters = { ...x.filters, deadline: e.target.value }; }) },
          ...[['', 'Any'], ['overdue', 'Overdue'], ['week', 'This week'], ['next7', 'In the next 7 days'], ['none', 'No deadline']]
            .map(([k, label]) => el('option', { value: k, text: label, selected: (view.filters.deadline || '') === k })))),
    ];
  },

  /** ✎: the views, to search, drag into order, rename, duplicate, copy a link to, or delete. */
  views() {
    const { list, base } = current();
    const q = (pop.search || '').toLowerCase();
    const search = el('input', { class: 'sc-input sc-input--sm tl-views-search', type: 'search', placeholder: 'Search views…', value: pop.search || '',
      oninput: (e) => { pop.search = e.target.value; drawPop(); pop.node.querySelector('.tl-views-search')?.focus(); }, onkeydown: (e) => e.stopPropagation() });
    const shown = list.filter((v) => !q || v.name.toLowerCase().includes(q));
    const tool = (text, title, run, cls = '') => el('button', { class: `ord-btn ${cls}`, text, title, onclick: (e) => { e.stopPropagation(); run(); } });
    const line = (v) => el('div', { class: `tl-view-line${v.id === base.id ? ' is-on' : ''}`, onclick: () => setActive(v.id) },
      el('span', { class: 'tl-kind-glyph', text: LAYOUTS[v.layout][0] }),
      el('span', { class: 'tl-view-name', text: v.name }),
      el('span', { class: 'tl-view-tools' },
        tool('✎', 'Rename view', () => { void renameView(v.id); }),
        tool('⧉', 'Duplicate view', () => { void duplicateView(v.id); }),
        tool('🔗', 'Copy link', () => copyViewLink(v.id)),
        tool('🗑', 'Delete view', () => { void deleteView(v.id); }, 'is-danger')));
    return [
      popHead('View order'),
      search,
      q ? el('div', { class: 'ord-list' }, ...shown.map(line))
        : orderable(list.map((v) => ({ key: v.id, node: line(v) })), (ids) => { void arrangeViews(ids); }, { buttons: false }),
      el('button', { class: 'tl-link tl-add-view', text: '＋ Add view', onclick: () => { closePop(); void newViewDialog(); } }),
    ];
  },
};

// ------------------------------------------------------------------ controls

let tabDrag = null;   // the id of a view tab being dragged

function viewTabs(list, base, dirty) {
  const tabMenu = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = list.findIndex((v) => v.id === base.id);
    const swap = (j) => { const ids = list.map((v) => v.id); [ids[i], ids[j]] = [ids[j], ids[i]]; void arrangeViews(ids); };
    showMenu(r.left, r.bottom + 4, [
      dirty ? { icon: '✓', label: 'Save changes to this view', run: () => { void saveView(); } } : null,
      dirty ? { icon: '↺', label: 'Discard changes', run: discardView } : null,
      dirty ? '-' : null,
      { icon: '✎', label: 'Rename view…', run: () => { void renameView(base.id); } },
      { icon: '⧉', label: 'Duplicate view', run: () => { void duplicateView(base.id); } },
      { icon: '🔗', label: 'Copy link', run: () => copyViewLink(base.id) },
      { icon: '←', label: 'Move left', disabled: i === 0, run: () => swap(i - 1) },
      { icon: '→', label: 'Move right', disabled: i === list.length - 1, run: () => swap(i + 1) },
      '-',
      { icon: '🗑', label: 'Delete view', danger: true, disabled: list.length < 2, run: () => { void deleteView(base.id); } },
    ]);
  };
  return list.map((v) => {
    const on = v.id === base.id;
    const tab = el('span', { class: `pt-tab tl-tab${on ? ' is-on' : ''}`, draggable: true, title: 'Drag to reorder' },
      el('button', { class: 'tl-tab-name', onclick: () => setActive(v.id), text: `${v.name}${on && dirty ? ' *' : ''}` }),
      on ? el('button', { class: 'tl-tab-more', text: '⋮', title: 'View menu', onclick: tabMenu }) : null);
    // A tab dragged onto another goes before or after it.
    const side = (e) => { const r = tab.getBoundingClientRect(); return e.clientX < r.left + r.width / 2 ? 'before' : 'after'; };
    const unmark = () => { for (const n of document.querySelectorAll('.tl-tab.is-drop-before, .tl-tab.is-drop-after')) n.classList.remove('is-drop-before', 'is-drop-after'); };
    tab.addEventListener('dragstart', (e) => { tabDrag = v.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', v.id); tab.classList.add('is-dragging'); });
    tab.addEventListener('dragend', () => { tabDrag = null; tab.classList.remove('is-dragging'); unmark(); });
    tab.addEventListener('dragover', (e) => {
      if (!tabDrag || tabDrag === v.id) return;
      e.preventDefault();
      const s = side(e);
      if (!tab.classList.contains(`is-drop-${s}`)) { unmark(); tab.classList.add(`is-drop-${s}`); }
    });
    tab.addEventListener('dragleave', (e) => { if (!tab.contains(e.relatedTarget)) tab.classList.remove('is-drop-before', 'is-drop-after'); });
    tab.addEventListener('drop', (e) => {
      if (!tabDrag || tabDrag === v.id) return;
      e.preventDefault();
      const moved = tabDrag;
      tabDrag = null;
      unmark();
      const ids = list.map((x) => x.id).filter((id) => id !== moved);
      ids.splice(ids.indexOf(v.id) + (side(e) === 'after' ? 1 : 0), 0, moved);
      void arrangeViews(ids);
    });
    return tab;
  });
}

function controls(count) {
  const { list, base, view, dirty } = current();
  const popButton = (kind, content, cls = '') => el('button', { class: `tl-pill tl-pop-btn ${cls}${pop?.kind === kind ? ' is-open' : ''}`, onclick: (e) => togglePop(kind, e.currentTarget) }, ...[].concat(content));
  const check = (label, key) => el('label', { class: 'tl-check' },
    el('input', { type: 'checkbox', checked: view[key], onchange: (e) => edit((x) => { x[key] = e.target.checked; }) }), el('span', { text: label }));
  const search = el('input', { class: 'sc-input sc-input--sm tl-search', type: 'search', placeholder: 'Search', value: page.query,
    oninput: (e) => { page.query = e.target.value; redraw(); lastRoot?.querySelector('.tl-search')?.focus(); }, onkeydown: (e) => e.stopPropagation() });

  const tabs = el('div', { class: 'pt-tabs tl-tabs' },
    scope === 'project'
      ? el('span', { class: 'pt-title tl-scope' }, icon('project', projectColour(store.project.colour)), el('span', { text: store.project.name }),
        el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: 'Open', title: 'The project window: stages, dates and activity', onclick: () => { void import('./projectsheet.js').then((m) => m.projectSheet()); } }))
      : el('span', { class: 'pt-title tl-scope' }, icon('project'), el('span', { text: 'Projects & Tasks' })),
    ...viewTabs(list, base, dirty),
    scope === 'all' ? el('button', { class: 'pt-tab', text: 'Team Schedule', onclick: () => set({ view: 'team' }) }) : null,
    el('button', { class: 'tl-icon-btn tl-pop-btn', text: '✎', title: 'Edit views — order, rename, duplicate, delete', onclick: (e) => togglePop('views', e.currentTarget) }),
    el('button', { class: 'tl-icon-btn', text: '＋', title: 'New view', onclick: () => { void newViewDialog(); } }),
    dirty ? el('span', { class: 'tl-dirty' },
      el('button', { class: 'sc-button sc-button--primary sc-button--sm', text: 'Save view', onclick: () => { void saveView(); } }),
      el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: 'Discard', onclick: discardView })) : null,
    el('span', { class: 'sc-spacer' }), search);

  const layoutSeg = el('span', { class: 'tl-seg' }, ...layoutsHere().map(([k, [, label]]) => el('button', {
    class: `tl-seg-btn${view.layout === k ? ' is-on' : ''}`, text: label, onclick: () => edit((x) => { x.layout = k; }) })));
  if (view.layout === 'workload') return el('div', { class: 'tl-controls-wrap' }, tabs, el('div', { class: 'tl-controls' }, el('div', { class: 'tl-row' }, layoutSeg)));

  const gantt = view.layout === 'gantt';
  const groupText = gantt ? 'Group by: Workspace › Stage › Project'
    : `Group by: ${[...view.groups.map((g) => FIELDS[g].replace(/ \(week\)/, '')), 'Task'].join(' › ')}`;
  const nFilters = filterCount(view);
  return el('div', { class: 'tl-controls-wrap' }, tabs,
    el('div', { class: 'tl-controls' },
      el('div', { class: 'tl-row' },
        gantt ? el('span', { class: 'tl-group-pill', text: groupText }) : popButton('group', groupText, 'tl-group-pill'),
        gantt ? null : popButton('sortGroups', 'Sort Groups'),
        layoutSeg,
        gantt ? null : popButton('sortTasks', view.sort.length ? `Sort Tasks (${view.sort.length})` : 'Sort Tasks'),
        popButton('filters', `▸ Filters (${nFilters})`, nFilters ? 'is-active' : ''),
        nFilters ? el('button', { class: 'ord-btn', text: '×', title: 'Clear filters', onclick: () => edit((x) => { x.filters = {}; }) }) : null,
        el('span', { class: 'sc-faint small', text: gantt ? `PROJECTS: ${count}` : `TASKS: ${count}` })),
      el('div', { class: 'tl-row' },
        gantt ? check('Show completed projects', 'completedProjects')
          : [check('Only show scheduled past deadline', 'pastOnly'), check('Show resolved tasks', 'resolved')])));
}

// ---------------------------------------------------------------- list

function cellOf(col, r, layout) {
  switch (col) {
    case 'eta': {
      const eta = etaOf(r, layout);
      const late = eta && r.deadline && eta > r.deadline;
      return el('td', {}, eta ? el('span', { class: late ? 'tl-late' : 'ts-when', text: shortDate(eta) }) : null, late ? el('span', { class: 'ps-late', title: 'Laid past its deadline', text: '!' }) : null);
    }
    case 'assignee': return el('td', { text: r.who.join(', ') });
    case 'project': return el('td', { class: 'sc-faint' }, el('span', { class: 'tl-value' }, icon('project', projectColour(planOf(r.planId)?.colour)), el('span', { text: r.planName })));
    case 'status': return el('td', {}, valueNode('status', r.status, r.status));
    case 'stage': return el('td', {}, valueNode('stage', r.phaseName || '', r.phaseName || 'No Stage', r));
    case 'priority': return el('td', {}, valueNode('priority', r.urgency, URGENCIES[r.urgency]?.label || ''));
    case 'start': return el('td', { class: 'sc-mono', text: r.start ? shortDate(r.start) : '' });
    case 'deadline': return el('td', { class: `sc-mono${r.pastDeadline ? ' tl-late' : ''}`, text: r.deadline ? shortDate(r.deadline) : '' });
    case 'duration': return el('td', { class: 'sc-mono', text: minText(r.expected) });
    case 'completed': return el('td', { class: 'sc-mono', text: minText(r.done) || '0m' });
    case 'completedAt': return el('td', { class: 'sc-faint', text: r.doneAt ? formatDate(r.doneAt.slice(0, 10), 'day') : '' });
    case 'labels': return el('td', {}, ...r.labels.map((l) => el('span', { class: 'ps-chip', text: l })));
    default: return el('td');
  }
}
function summaryOf(col, rs) {
  const distinct = (xs) => new Set(xs).size;
  const plural = (n, word) => (n ? `${n} ${word}${n === 1 ? '' : 's'}` : '');
  const range = (ds) => { const s = ds.filter(Boolean).sort(); return s.length ? (s[0] === s.at(-1) ? shortDate(s[0]) : `${formatDate(s[0], 'day')} – ${formatDate(s.at(-1), 'day')}`) : ''; };
  switch (col) {
    case 'assignee': return el('td', { class: 'sc-faint', text: plural(distinct(rs.flatMap((r) => r.who)), 'assignee') });
    case 'status': return el('td', { class: 'sc-faint', text: plural(distinct(rs.map((r) => r.status)), 'status') });
    case 'stage': return el('td', { class: 'sc-faint', text: plural(distinct(rs.map((r) => r.phaseName).filter(Boolean)), 'stage') });
    case 'priority': {
      const n = (k) => rs.filter((r) => r.urgency === k).length;
      return el('td', {}, ...Object.keys(URGENCIES).filter((k) => n(k)).map((k) => el('span', { class: 'tl-flagcount', style: { color: FLAG[k] }, text: `⚑${n(k)}` })));
    }
    case 'start': return el('td', { class: 'sc-mono sc-faint', text: range(rs.map((r) => r.start)) });
    case 'deadline': return el('td', { class: 'sc-mono sc-faint', text: range(rs.map((r) => r.deadline)) });
    case 'duration': return el('td', { class: 'sc-mono', text: minText(rs.reduce((n, r) => n + r.expected, 0)) });
    case 'completed': return el('td', { class: 'sc-mono', text: minText(rs.reduce((n, r) => n + r.done, 0)) || '0m' });
    default: return el('td');
  }
}

function listLayout(list, view, layout) {
  const cols = view.columns;
  const columnMenu = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.right - 200, r.bottom + 4, [{ note: 'Columns' }, ...Object.entries(COLUMNS).map(([k, label]) => ({
      label, checked: cols.includes(k),
      run: () => edit((x) => { x.columns = x.columns.includes(k) ? x.columns.filter((c) => c !== k) : Object.keys(COLUMNS).filter((c) => c === k || x.columns.includes(c)); }),
    }))]);
  };
  const table = el('table', { class: 'sc-table tl-table' },
    el('thead', {}, el('tr', {}, el('th', { text: 'Name' }), ...cols.map((c) => el('th', { text: COLUMNS[c] })),
      el('th', { class: 'tl-col-add' }, el('button', { class: 'ord-btn', text: '＋', title: 'Columns', onclick: columnMenu })))));
  const body = el('tbody');
  const pad = (level) => ({ paddingLeft: `${10 + level * 18}px` });
  const addRow = (target, level) => body.append(el('tr', { class: 'tl-add' },
    el('td', { colspan: cols.length + 2, style: pad(level) }, el('button', { class: 'ps-add', text: '＋ Add task', onclick: () => { void addTo(target); } }))));
  const leaf = (rs, level, target) => {
    sortRows(rs, view, layout).forEach((r, i) => body.append(el('tr', { class: `clickable tl-task${r.percent === 100 ? ' is-done' : ''}${r.cancelled ? ' is-cancelled' : ''}`, onclick: () => { void openRow(r); } },
      el('td', { style: pad(level) }, el('span', { class: 'sc-faint tl-n', text: String(i + 1) }), el('span', { class: `tl-ring${r.percent === 100 ? ' is-done' : ''}` }), el('span', { class: 'tl-name', text: r.name }),
        r.auto && r.percent < 100 ? el('span', { class: 'ps-auto', title: 'Auto-scheduled', text: '✦' }) : null),
      ...cols.map((c) => cellOf(c, r, layout)), el('td'))));
    if (target) addRow(target, level);
  };
  const walk = (groups, level) => {
    for (const g of groups) {
      const shut = folded.has(g.key);
      body.append(el('tr', { class: 'tl-group', onclick: () => { if (shut) folded.delete(g.key); else folded.add(g.key); redraw(); } },
        el('td', { style: pad(level) },
          el('span', { class: 'at-twist', text: shut ? '▸' : '▾' }),
          valueNode(g.field, g.value, g.label, g.sample),
          el('span', { class: 'sc-faint', text: ` (${FIELDS[g.field].replace(/ \(week\)/, '')})` }),
          g.field === 'stage' && g.sample?.activePhase ? el('span', { class: 'ts-current', text: 'Current' }) : null,
          el('span', { class: 'sc-faint tl-count', text: ` ${g.rows.length}` })),
        ...cols.map((c) => summaryOf(c, g.rows)), el('td')));
      if (shut) continue;
      if (g.children) walk(g.children, level + 1);
      else leaf(g.rows, level + 1, targetOf(g.path, g.rows));
    }
  };
  const tree = groupTree(list, view);
  if (tree) walk(tree, 0);
  else leaf(list, 0, scope === 'project' ? { planId: store.project.id } : null);
  table.append(body);
  return el('div', { class: 'tl-scroll' }, table);
}

// ---------------------------------------------------------------- kanban

function card(r) {
  return el('div', { class: `ts-card${r.percent === 100 ? ' is-done' : ''}`, onclick: () => { void openRow(r); } },
    el('div', { class: 'ts-card-project sc-faint small' }, el('span', { class: 'tl-value' }, icon('project', projectColour(planOf(r.planId)?.colour)), el('span', { text: r.planName })),
      el('span', { class: `ts-health${r.pastDeadline ? ' is-late' : ''}`, text: r.pastDeadline ? '!' : '✓' })),
    el('div', { class: 'ts-card-row' },
      el('span', { class: 'ts-flag', style: { color: FLAG[r.urgency] }, title: `${URGENCIES[r.urgency].label} priority`, text: '⚑' }),
      el('span', { class: 'ts-status', text: `○ ${r.status}` }),
      el('span', { class: 'sc-spacer' }),
      r.deadline ? el('span', { class: r.pastDeadline ? 'tl-late' : 'ts-when', text: shortDate(r.deadline) }) : null,
      r.auto && r.percent < 100 ? el('span', { class: 'ps-auto', text: '✦' }) : null),
    el('div', { class: 'ts-card-title', text: r.name }),
    el('div', { class: 'ts-card-row sc-faint small' }, el('span', { text: `${minText(r.done) || '0m'} of ${minText(r.expected) || '0m'}` }),
      el('span', { text: r.deadline ? formatDate(r.deadline, 'long') : '' }), el('span', { text: r.who[0] || '' })),
    r.labels.length ? el('div', { class: 'ts-labels' }, ...r.labels.map((l) => el('span', { class: 'ps-chip', text: l }))) : null);
}

/** Kanban: the last level of grouping is the columns; the levels above it are lanes. */
function kanbanLayout(list, view, layout) {
  const levels = view.groups;
  const colField = levels.at(-1) || null;
  const laneFields = levels.slice(0, -1);
  const lanes = [];
  const collect = (groups, trail) => {
    for (const g of groups) {
      const t = [...trail, g];
      if (g.children) collect(g.children, t);
      else lanes.push({ key: g.key, trail: t, rows: g.rows, path: g.path });
    }
  };
  const laneTree = laneFields.length ? groupTree(list, view, laneFields) : null;
  if (laneTree) collect(laneTree, []); else lanes.push({ key: 'all', trail: [], rows: list, path: {} });
  const wrap = el('div', { class: 'tl-lanes' });
  for (const lane of lanes) {
    const shut = folded.has(`k${lane.key}`);
    if (lane.trail.length) {
      wrap.append(el('div', { class: 'tl-lane-head', onclick: () => { if (shut) folded.delete(`k${lane.key}`); else folded.add(`k${lane.key}`); redraw(); } },
        el('span', { class: 'at-twist', text: shut ? '▸' : '▾' }),
        ...lane.trail.flatMap((g, i) => [i ? el('span', { class: 'sc-faint', text: '›' }) : null, valueNode(g.field, g.value, g.label, g.sample)]),
        el('span', { class: 'sc-faint', text: String(lane.rows.length) })));
    }
    if (shut) continue;
    const cols = colField ? groupTree(lane.rows, view, [colField], 0, lane.key, lane.path)
      : [{ key: `${lane.key}/all`, field: null, value: '', label: 'All tasks', rows: lane.rows, path: lane.path }];
    wrap.append(el('div', { class: 'ts-board' }, ...cols.map((c) => {
      const target = targetOf(c.path || lane.path, c.rows.length ? c.rows : lane.rows);
      return el('div', { class: 'ts-col' },
        el('div', { class: 'ts-col-head' },
          c.field ? valueNode(c.field, c.value, c.label, c.sample) : el('strong', { text: c.label }),
          el('span', { class: 'sc-faint', text: String(c.rows.length) }), el('span', { class: 'sc-spacer' }),
          target ? el('button', { class: 'side-icon', text: '＋', title: 'Add a task here', onclick: () => { void addTo(target); } }) : null),
        ...sortRows(c.rows, view, layout).map(card));
    })));
  }
  return el('div', { class: 'tl-kanban tl-scroll' }, wrap);
}

// ---------------------------------------------------------------- gantt

function ganttLayout(view) {
  const todayDay = toDay(today());
  const list = plans.filter((p) => (view.completedProjects || !p.archived) && (!view.filters.workspace || p.workspaceId === view.filters.workspace));
  const spanDays = { month: 35, quarter: 91, year: 365 }[page.ganttSpan] || 91;
  const from = page.ganttFrom ?? weekStart(todayDay - 28);
  const to = from + spanDays;
  const x = (d) => ((d - from) / (to - from)) * 100;
  const scale = el('div', { class: 'pg-scale' });
  for (let m = monthStart(from); m < to; m = addMonths(m, 1)) {
    if (m >= from) scale.append(el('span', { class: 'pg-month', style: { left: `${x(m)}%` }, text: `${MONTH_NAMES[+fromDay(m).slice(5, 7) - 1].slice(0, 3)} ${fromDay(m).slice(0, 4)}` }));
  }
  for (let w = weekStart(from); w < to; w += 7) if (w >= from) scale.append(el('span', { class: 'pg-week', style: { left: `${x(w)}%` }, text: String(+fromDay(w).slice(8, 10)) }));
  const nav = el('div', { class: 'pg-nav' },
    el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: '‹', onclick: () => { page.ganttFrom = from - Math.round(spanDays / 3); redraw(); } }),
    el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: '›', onclick: () => { page.ganttFrom = from + Math.round(spanDays / 3); redraw(); } }),
    el('select', { class: 'sc-select sc-select--sm', onchange: (e) => { page.ganttSpan = e.target.value; redraw(); } },
      ...[['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']].map(([k, t]) => el('option', { value: k, text: t, selected: page.ganttSpan === k }))),
    el('button', { class: 'sc-button sc-button--sm', text: 'Today', onclick: () => { page.ganttFrom = null; redraw(); } }));
  const body = el('div', { class: 'pg-body' });
  const byWs = new Map();
  for (const p of list) { if (!byWs.has(p.workspaceId)) byWs.set(p.workspaceId, []); byWs.get(p.workspaceId).push(p); }
  for (const [w, ps] of [...byWs].sort((a, b) => wsName(a[0]).localeCompare(wsName(b[0])))) {
    const key = `g|${w}`;
    const shut = folded.has(key);
    body.append(el('div', { class: 'pg-ws', onclick: () => { if (shut) folded.delete(key); else folded.add(key); redraw(); } },
      el('span', { class: 'at-twist', text: shut ? '▸' : '▾' }), el('span', { class: 'tl-value' }, icon('workspace'), el('strong', { text: wsName(w) })), el('span', { class: 'sc-faint', text: ` ${ps.length}` })));
    if (shut) continue;
    const byStage = new Map();
    for (const p of ps) { const k = p.stageName || ''; if (!byStage.has(k)) byStage.set(k, []); byStage.get(k).push(p); }
    for (const [stage, sp] of [...byStage].sort((a, b) => (a[0] === '') - (b[0] === '') || a[0].localeCompare(b[0]))) {
      const lane = el('div', { class: 'pg-lane' });
      for (const p of sp.sort((a, b) => a.start.localeCompare(b.start))) {
        const s = toDay(p.start);
        const f = Math.max(s, toDay(p.finish || p.start));
        const offLeft = f < from;
        const offRight = s > to;
        const left = Math.max(0, Math.min(100, x(s)));
        const right = Math.max(0, Math.min(100, x(f + 1)));
        lane.append(el('button', {
          class: `pg-bar${offLeft ? ' is-before' : ''}${offRight ? ' is-after' : ''}${p.archived ? ' is-done' : ''}`,
          style: offLeft ? { left: '0%' } : offRight ? { right: '0%' } : { left: `${left}%`, width: `max(${Math.max(0.8, right - left)}%, 150px)` },
          title: `${p.name} · ${formatDate(p.start, 'long')} – ${formatDate(p.finish, 'long')}`,
          onclick: () => { void import('./projectsheet.js').then((m) => m.projectSheet({ planId: p.id })); },
        }, offLeft ? el('span', { class: 'pg-arrow', text: '‹' }) : null,
          el('span', { class: 'pg-bar-text' }, el('strong', { text: p.name }), el('span', { text: `${formatDate(p.start, 'day')} – ${formatDate(p.finish, 'day')}` })),
          offRight ? el('span', { class: 'pg-arrow', text: '›' }) : null));
      }
      body.append(el('div', { class: 'pg-row' },
        el('div', { class: 'pg-label' }, stage ? el('span', { class: 'ps-chip', style: { '--st': sp[0].stageColour }, text: stage }) : el('span', { class: 'ps-chip is-none', text: 'No stage' }), el('span', { class: 'sc-faint', text: String(sp.length) })),
        el('div', { class: 'pg-track' }, todayDay >= from && todayDay <= to ? el('div', { class: 'pg-today', style: { left: `${x(todayDay)}%` } }) : null, lane)));
    }
  }
  return el('div', { class: 'pg' },
    el('div', { class: 'pg-head' }, el('div', { class: 'pg-label' }, nav), el('div', { class: 'pg-track' }, scale,
      todayDay >= from && todayDay <= to ? el('span', { class: 'pg-today-tag', style: { left: `${x(todayDay)}%` }, text: `${WEEKDAY_NAMES[weekday(todayDay)].slice(0, 3)} ${formatDate(today(), 'day')}` }) : null)),
    body);
}

// ---------------------------------------------------------------- page

function redraw() {
  if (lastRoot?.isConnected) renderAllTasks(lastRoot, { scope });
  drawPop();
}

/** Projects & Tasks (`scope: 'all'`), or the open project's Task list (`scope: 'project'`). */
export function renderAllTasks(root, { scope: s = 'all' } = {}) {
  if (s !== scope) { scope = s; closePop(); }
  lastRoot = root;
  clear(root);
  if (!loaded && !loading) void reloadAllTasks();
  const { view } = current();
  const pane = el('div', { class: 'alltasks-pane tl-pane' });
  root.append(pane);
  let layout = null;
  try { layout = currentLayout(); } catch { layout = null; }
  const list = visible(view, layout);
  const projectCount = plans.filter((p) => (view.completedProjects || !p.archived) && (!view.filters.workspace || p.workspaceId === view.filters.workspace)).length;
  pane.append(controls(view.layout === 'gantt' ? projectCount : list.length));
  if (view.layout === 'workload') {
    // Workload is Resource Usage: every person's hours by day, over every plan.
    const host = el('div', { class: 'tl-workload' });
    pane.append(host);
    renderResourceUsage(host);
    return;
  }
  if (loading && !loaded) { pane.append(el('p', { class: 'empty', text: 'Reading every plan on the shelf…' })); return; }
  if (view.layout === 'gantt' && scope === 'all') { pane.append(ganttLayout(view)); return; }
  if (!list.length && view.hideEmpty) {
    pane.append(el('div', { class: 'empty tl-empty' },
      el('p', { text: scopeRows(view).length ? 'No tasks found. Some may be hidden by filters.' : 'No tasks here yet.' }),
      filterCount(view) ? el('button', { class: 'sc-button sc-button--sm', text: 'Clear filters', onclick: () => edit((x) => { x.filters = {}; }) }) : null,
      scope === 'project' ? el('button', { class: 'sc-button sc-button--sm', text: '＋ Add task', onclick: () => { void addTo({ planId: store.project.id }); } }) : null));
    return;
  }
  pane.append(view.layout === 'kanban' ? kanbanLayout(list, view, layout) : listLayout(list, view, layout));
}
