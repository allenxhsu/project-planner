// Projects & Tasks ▸ Task List: every task in every project, as Motion shows
// it — grouped Workspace › Project › Stage, in one of three layouts:
//
//   List    one row a task, with ETA, assignee, project, when it was
//           completed, duration, deadline and how much is done
//   Kanban  a tab per workspace, each project's stages as columns of cards
//   Gantt   the projects on a line of dates, by workspace, with the stage
//           each is in
//
// It reads every plan on the shelf, not only the open one. Each plan is
// parsed and scheduled once and kept until its record changes, because doing
// that for twenty plans on every keystroke in the search box would be waste.

import { el, clear } from '../util.js';
import { store, set } from '../state/store.js';
import * as act from '../state/actions.js';
import { planRecords, openPlan, listWorkspaces } from '../state/sync.js';
import { projectsTasksTabs } from './teamschedule.js';
import { currentLayout } from './calendar.js';
import { parse } from '../io/json.js';
import { computeSchedule } from '../model/schedule.js';
import { isSummary, phaseOf, getPhase, phases, stageOf, urgencyOf, URGENCIES } from '../model/model.js';
import { hoursLeft, expectedHours, agendaOf } from '../model/agenda.js';
import { stageColour } from '../model/stages.js';
import { formatDate, toDay, fromDay, today, weekStart, monthStart, addMonths, MONTH_NAMES, WEEKDAY_NAMES, weekday } from '../model/calendar.js';

/** planId → { updatedAt, plan, rows }. */
const cache = new Map();
let rows = [];
let plans = [];
let spaces = [];
let loading = true;
let loaded = false;

const saved = (() => { try { return JSON.parse(localStorage.getItem('project-planner:tasklist') || '{}'); } catch { return {}; } })();
const opts = {
  layout: saved.layout || 'list',            // list | kanban | gantt
  group: saved.group || 'wps',               // see GROUPS
  workspace: saved.workspace || '',          // '' is all
  pastOnly: !!saved.pastOnly,
  resolved: !!saved.resolved,
  query: '',
  kanbanTab: saved.kanbanTab || null,
  ganttFrom: null,
  ganttSpan: saved.ganttSpan || 'quarter',
  completedProjects: !!saved.completedProjects,
};
const remember = () => { try { localStorage.setItem('project-planner:tasklist', JSON.stringify({ ...opts, query: undefined, ganttFrom: undefined })); } catch { /* private mode */ } };

export const GROUPS = {
  wps: 'Workspace › Project › Stage › Task',
  ps: 'Project › Stage › Task',
  project: 'Project › Task',
  assignee: 'Assignee › Task',
  status: 'Status › Task',
  deadline: 'Deadline week › Task',
  none: 'No grouping',
};
const folded = new Set();
const minText = (m) => (!m ? '' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`);
const shortDate = (iso) => (iso ? `${WEEKDAY_NAMES[weekday(toDay(iso))].slice(0, 3)} ${formatDate(iso, 'day')}` : '');

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
        order: i, name: t.name, deadline: t.deadline, percent: s.percent, milestone: s.milestone,
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

function visible(layout) {
  const q = opts.query.trim().toLowerCase();
  return rows.filter((r) => {
    if (r.planArchived) return false;
    if (opts.workspace && r.workspaceId !== opts.workspace) return false;
    if (!opts.resolved && (r.percent === 100 || r.cancelled)) return false;
    if (opts.pastOnly) {
      const eta = etaOf(r, layout);
      if (!(r.deadline && eta && eta > r.deadline)) return false;
    }
    return !q || `${r.name} ${r.planName} ${r.who.join(' ')} ${r.labels.join(' ')}`.toLowerCase().includes(q);
  });
}

async function openRow(r) {
  const { taskSheet } = await import('./blockmenu.js');
  await taskSheet({ planId: r.planId, taskId: r.taskId });
  void reloadAllTasks();
}
/** A new task at the end of a group, in its project and stage, opened at once. */
async function addTo(planId, phaseId) {
  if (planId !== store.project.id && !(await openPlan(planId))) return;
  const made = act.newTaskInPhase(phaseId || null);
  if (made) { const { taskSheet } = await import('./blockmenu.js'); await taskSheet({ planId, taskId: made.id }); }
  void reloadAllTasks();
}
const wsName = (id) => (id ? spaces.find((w) => w.id === id)?.name || 'Workspace' : 'No workspace');

// ---------------------------------------------------------------- controls

function controls(root, count) {
  const redraw = () => { remember(); renderAllTasks(root); };
  const pick = (label, value, options, onchange, cls = '') => el('select', { class: `sc-select sc-select--sm ${cls}`, title: label, onchange: (e) => { onchange(e.target.value); redraw(); } },
    ...options.map(([v, t]) => el('option', { value: v, text: t, selected: v === value })));
  const check = (label, key) => el('label', { class: 'tl-check' },
    el('input', { type: 'checkbox', checked: opts[key], onchange: (e) => { opts[key] = e.target.checked; redraw(); } }), el('span', { text: label }));
  const search = el('input', { class: 'sc-input sc-input--sm tl-search', type: 'search', placeholder: 'Search', value: opts.query,
    oninput: (e) => { opts.query = e.target.value; renderAllTasks(root); root.querySelector('.tl-search')?.focus(); }, onkeydown: (e) => e.stopPropagation() });
  return el('div', { class: 'tl-controls' },
    el('div', { class: 'tl-row' },
      opts.layout === 'gantt'
        ? el('span', { class: 'tl-group-pill', text: 'Group by: Workspace › Stage › Project' })
        : pick('Group by', opts.group, Object.entries(GROUPS).map(([k, v]) => [k, `Group by: ${v}`]), (v) => { opts.group = v; }, 'tl-group'),
      el('span', { class: 'tl-seg' }, ...[['list', 'List'], ['kanban', 'Kanban'], ['gantt', 'Gantt']].map(([k, t]) => el('button', {
        class: `tl-seg-btn${opts.layout === k ? ' is-on' : ''}`, text: t, onclick: () => { opts.layout = k; redraw(); } }))),
      pick('Workspace', opts.workspace, [['', 'Workspace: All'], ...spaces.map((w) => [w.id, `Workspace: ${w.name}`])], (v) => { opts.workspace = v; }),
      el('span', { class: 'sc-faint small', text: opts.layout === 'gantt' ? `PROJECTS: ${count}` : `TASKS: ${count}` }),
      el('span', { class: 'sc-spacer' }), search),
    el('div', { class: 'tl-row' },
      opts.layout === 'gantt' ? check('Show completed projects', 'completedProjects')
        : [check('Only show scheduled past deadline', 'pastOnly'), check('Show resolved tasks', 'resolved')]));
}

// ---------------------------------------------------------------- grouping

/** [{ key, label, kind, colour, planId, phaseId, active, children|rows }] */
function groupRows(list) {
  const by = (items, keyOf, meta) => {
    const map = new Map();
    for (const r of items) { const k = keyOf(r); if (!map.has(k)) map.set(k, []); map.get(k).push(r); }
    return [...map].map(([k, rs]) => ({ key: k, rows: rs, ...meta(k, rs) }));
  };
  const stageLevel = (rs, prefix) => by(rs, (r) => r.phaseId || '', (k, g) => ({
    key: `${prefix}|s|${k}`, label: k ? g[0].phaseName : 'No Stage', kind: 'Stage', colour: g[0].phaseColour, planId: g[0].planId, phaseId: k || null, active: g[0].activePhase, order: g[0].phaseOrder,
  })).sort((a, b) => a.order - b.order);
  const projectLevel = (rs, prefix, withStages) => by(rs, (r) => r.planId, (k, g) => ({
    key: `${prefix}|p|${k}`, label: g[0].planName, kind: 'Project', planId: k,
    children: withStages ? stageLevel(g, `${prefix}|p|${k}`) : null,
  })).sort((a, b) => a.label.localeCompare(b.label));
  switch (opts.group) {
    case 'wps': return by(list, (r) => r.workspaceId, (k) => ({ key: `w|${k}`, label: wsName(k), kind: 'Workspace' }))
      .sort((a, b) => (a.key === 'w|') - (b.key === 'w|') || a.label.localeCompare(b.label))
      .map((g) => ({ ...g, children: projectLevel(g.rows, g.key, true) }));
    case 'ps': return projectLevel(list, 'x', true);
    case 'project': return projectLevel(list, 'x', false);
    case 'assignee': return by(list, (r) => r.who[0] || '', (k) => ({ key: `a|${k}`, label: k || 'Unassigned', kind: 'Assignee' })).sort((a, b) => (a.key === 'a|') - (b.key === 'a|') || a.label.localeCompare(b.label));
    case 'status': return by(list, (r) => r.status, (k) => ({ key: `st|${k}`, label: k, kind: 'Status' }));
    case 'deadline': return by(list, (r) => (r.deadline ? fromDay(weekStart(toDay(r.deadline))) : ''), (k) => ({ key: `d|${k}`, label: k ? `${formatDate(k, 'day')} – ${formatDate(fromDay(toDay(k) + 6), 'day')}` : 'No deadline', kind: 'Deadline', sort: k || '9999' }))
      .sort((a, b) => a.sort.localeCompare(b.sort));
    default: return [{ key: 'all', label: null, rows: list }];
  }
}

// ---------------------------------------------------------------- list

function listLayout(list, root, layout) {
  const table = el('table', { class: 'sc-table tl-table' },
    el('thead', {}, el('tr', {}, ...['Name', 'ETA', 'Assignee', 'Project', 'Completed at', 'Duration', 'Deadline', 'Completed'].map((h) => el('th', { text: h })))));
  const body = el('tbody');
  const sum = (rs) => ({ exp: rs.reduce((n, r) => n + r.expected, 0), done: rs.reduce((n, r) => n + r.done, 0),
    due: rs.map((r) => r.deadline).filter(Boolean).sort(), who: new Set(rs.flatMap((r) => r.who)).size });
  const head = (g, level) => {
    const shut = folded.has(g.key);
    const all = g.rows;
    const s = sum(all);
    body.append(el('tr', { class: `tl-group level-${level}`, onclick: () => { if (shut) folded.delete(g.key); else folded.add(g.key); renderAllTasks(root); } },
      el('td', { colspan: 1 },
        el('span', { class: 'at-twist', text: shut ? '▸' : '▾' }),
        g.kind === 'Stage' && g.phaseId ? el('span', { class: 'ps-chip', style: { '--st': g.colour }, text: g.label }) : el('span', { class: 'tl-group-name', text: g.label }),
        g.kind ? el('span', { class: 'sc-faint', text: ` (${g.kind})` }) : null,
        g.active ? el('span', { class: 'ts-current', text: 'Current' }) : null,
        el('span', { class: 'sc-faint tl-count', text: ` ${all.length}` })),
      el('td', {}), el('td', { class: 'sc-faint', text: s.who ? `${s.who} assignee${s.who === 1 ? '' : 's'}` : '' }), el('td', {}), el('td', {}),
      el('td', { class: 'sc-mono', text: minText(s.exp) }),
      el('td', { class: 'sc-mono sc-faint', text: s.due.length ? (s.due[0] === s.due.at(-1) ? shortDate(s.due[0]) : `${formatDate(s.due[0], 'day')} – ${formatDate(s.due.at(-1), 'day')}`) : '' }),
      el('td', { class: 'sc-mono', text: minText(s.done) || '0m' })));
    return shut;
  };
  const row = (r, level, n) => {
    const eta = etaOf(r, layout);
    const late = eta && r.deadline && eta > r.deadline;
    body.append(el('tr', { class: `clickable tl-task level-${level}${r.percent === 100 ? ' is-done' : ''}${r.cancelled ? ' is-cancelled' : ''}`, onclick: () => { void openRow(r); } },
      el('td', {}, el('span', { class: 'sc-faint tl-n', text: String(n) }), el('span', { class: `tl-ring${r.percent === 100 ? ' is-done' : ''}` }), el('span', { class: 'tl-name', text: r.name }),
        r.auto && r.percent < 100 ? el('span', { class: 'ps-auto', title: 'Auto-scheduled', text: '✦' }) : null),
      el('td', {}, eta ? el('span', { class: late ? 'tl-late' : 'ts-when', text: shortDate(eta) }) : null, late ? el('span', { class: 'ps-late', title: 'Laid past its deadline', text: '!' }) : null),
      el('td', { text: r.who.join(', ') }),
      el('td', { class: 'sc-faint', text: `▢ ${r.planName}` }),
      el('td', { class: 'sc-faint', text: r.doneAt ? formatDate(r.doneAt.slice(0, 10), 'day') : '' }),
      el('td', { class: 'sc-mono', text: minText(r.expected) }),
      el('td', { class: `sc-mono${r.pastDeadline ? ' tl-late' : ''}`, text: r.deadline ? shortDate(r.deadline) : '' }),
      el('td', { class: 'sc-mono', text: minText(r.done) || '0m' })));
  };
  const addRow = (g, level) => (g.planId ? body.append(el('tr', { class: `tl-add level-${level}` },
    el('td', { colspan: 8 }, el('button', { class: 'ps-add', text: '＋ Add task', onclick: () => { void addTo(g.planId, g.phaseId); } })))) : null);
  const walk = (groups, level) => {
    for (const g of groups) {
      if (g.label !== null && head(g, level)) continue;
      if (g.children) walk(g.children, level + 1);
      else {
        [...g.rows].sort((a, b) => (a.planId === b.planId ? a.order - b.order : a.planName.localeCompare(b.planName))).forEach((r, i) => row(r, level + 1, i + 1));
        if (g.kind === 'Stage' || (g.kind === 'Project' && opts.group === 'project')) addRow(g, level + 1);
      }
    }
  };
  walk(groupRows(list), 0);
  table.append(body);
  return el('div', { class: 'tl-scroll' }, table);
}

// ---------------------------------------------------------------- kanban

function card(r) {
  const flag = { now: 'var(--sc-danger)', high: '#e0703a', normal: '#d9a52b', low: 'var(--sc-text-3)' }[r.urgency];
  return el('div', { class: `ts-card${r.percent === 100 ? ' is-done' : ''}`, onclick: () => { void openRow(r); } },
    el('div', { class: 'ts-card-project sc-faint small' }, el('span', { text: `▢ ${r.planName}` }),
      el('span', { class: `ts-health${r.pastDeadline ? ' is-late' : ''}`, text: r.pastDeadline ? '!' : '✓' })),
    el('div', { class: 'ts-card-row' },
      el('span', { class: 'ts-flag', style: { color: flag }, title: `${URGENCIES[r.urgency].label} priority`, text: '⚑' }),
      el('span', { class: 'ts-status', text: `○ ${r.status}` }),
      el('span', { class: 'sc-spacer' }),
      r.deadline ? el('span', { class: r.pastDeadline ? 'tl-late' : 'ts-when', text: shortDate(r.deadline) }) : null,
      r.auto && r.percent < 100 ? el('span', { class: 'ps-auto', text: '✦' }) : null),
    el('div', { class: 'ts-card-title', text: r.name }),
    el('div', { class: 'ts-card-row sc-faint small' }, el('span', { text: `${minText(r.done) || '0m'} of ${minText(r.expected) || '0m'}` }),
      el('span', { text: r.deadline ? formatDate(r.deadline, 'long') : '' }), el('span', { text: r.who[0] || '' })),
    r.labels.length ? el('div', { class: 'ts-labels' }, ...r.labels.map((l) => el('span', { class: 'ps-chip', text: l }))) : null);
}

function kanbanLayout(list, root) {
  const byWs = new Map();
  for (const r of list) { if (!byWs.has(r.workspaceId)) byWs.set(r.workspaceId, []); byWs.get(r.workspaceId).push(r); }
  const tabs = [...byWs.keys()].sort((a, b) => wsName(a).localeCompare(wsName(b)));
  if (!tabs.length) return el('p', { class: 'empty', text: 'No tasks match.' });
  if (!tabs.includes(opts.kanbanTab)) opts.kanbanTab = tabs[0];
  const wrap = el('div', { class: 'tl-kanban' },
    el('div', { class: 'ts-days' }, ...tabs.map((w) => el('button', { class: `ts-day${opts.kanbanTab === w ? ' is-on' : ''}`, onclick: () => { opts.kanbanTab = w; remember(); renderAllTasks(root); } },
      el('strong', { text: `◫ ${wsName(w)}` }), el('span', { class: 'sc-faint', text: String(byWs.get(w).length) })))));
  const inWs = byWs.get(opts.kanbanTab);
  const byPlan = new Map();
  for (const r of inWs) { if (!byPlan.has(r.planId)) byPlan.set(r.planId, []); byPlan.get(r.planId).push(r); }
  const lanes = el('div', { class: 'tl-lanes' });
  for (const [planId, rs] of [...byPlan].sort((a, b) => a[1][0].planName.localeCompare(b[1][0].planName))) {
    const cols = new Map();
    for (const r of rs) { const k = r.phaseId || ''; if (!cols.has(k)) cols.set(k, []); cols.get(k).push(r); }
    lanes.append(el('div', { class: 'tl-lane' },
      el('div', { class: 'tl-lane-head' }, el('button', { class: 'ps-chip is-none', text: `▢ ${rs[0].planName}`, onclick: () => { void import('./projectsheet.js').then((m) => m.projectSheet({ planId })); } }), el('span', { class: 'sc-faint', text: String(rs.length) })),
      el('div', { class: 'ts-board' }, ...[...cols].sort((a, b) => a[1][0].phaseOrder - b[1][0].phaseOrder).map(([k, cs]) => el('div', { class: 'ts-col' },
        el('div', { class: 'ts-col-head' },
          k ? el('span', { class: 'ps-chip', style: { '--st': cs[0].phaseColour }, text: cs[0].phaseName }) : el('span', { class: 'ps-chip is-none', text: 'No Stage' }),
          el('span', { class: 'sc-faint', text: String(cs.length) }), el('span', { class: 'sc-spacer' }),
          el('button', { class: 'side-icon', text: '＋', title: 'Add a task to this stage', onclick: () => { void addTo(planId, k || null); } })),
        ...cs.sort((a, b) => a.order - b.order).map(card))))));
  }
  wrap.append(lanes);
  return wrap;
}

// ---------------------------------------------------------------- gantt

function ganttLayout(root) {
  const todayDay = toDay(today());
  const list = plans.filter((p) => (opts.completedProjects || !p.archived) && (!opts.workspace || p.workspaceId === opts.workspace));
  const spanDays = { month: 35, quarter: 91, year: 365 }[opts.ganttSpan] || 91;
  const from = opts.ganttFrom ?? weekStart(todayDay - 28);
  const to = from + spanDays;
  const x = (d) => ((d - from) / (to - from)) * 100;
  const scale = el('div', { class: 'pg-scale' });
  for (let m = monthStart(from); m < to; m = addMonths(m, 1)) {
    if (m >= from) scale.append(el('span', { class: 'pg-month', style: { left: `${x(m)}%` }, text: `${MONTH_NAMES[+fromDay(m).slice(5, 7) - 1].slice(0, 3)} ${fromDay(m).slice(0, 4)}` }));
  }
  for (let w = weekStart(from); w < to; w += 7) if (w >= from) scale.append(el('span', { class: 'pg-week', style: { left: `${x(w)}%` }, text: String(+fromDay(w).slice(8, 10)) }));
  const nav = el('div', { class: 'pg-nav' },
    el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: '‹', onclick: () => { opts.ganttFrom = from - Math.round(spanDays / 3); renderAllTasks(root); } }),
    el('button', { class: 'sc-button sc-button--ghost sc-button--sm', text: '›', onclick: () => { opts.ganttFrom = from + Math.round(spanDays / 3); renderAllTasks(root); } }),
    el('select', { class: 'sc-select sc-select--sm', onchange: (e) => { opts.ganttSpan = e.target.value; remember(); renderAllTasks(root); } },
      ...[['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']].map(([k, t]) => el('option', { value: k, text: t, selected: opts.ganttSpan === k }))),
    el('button', { class: 'sc-button sc-button--sm', text: 'Today', onclick: () => { opts.ganttFrom = null; renderAllTasks(root); } }));
  const body = el('div', { class: 'pg-body' });
  const byWs = new Map();
  for (const p of list) { if (!byWs.has(p.workspaceId)) byWs.set(p.workspaceId, []); byWs.get(p.workspaceId).push(p); }
  for (const [w, ps] of [...byWs].sort((a, b) => wsName(a[0]).localeCompare(wsName(b[0])))) {
    const key = `g|${w}`;
    const shut = folded.has(key);
    body.append(el('div', { class: 'pg-ws', onclick: () => { if (shut) folded.delete(key); else folded.add(key); renderAllTasks(root); } },
      el('span', { class: 'at-twist', text: shut ? '▸' : '▾' }), el('strong', { text: `◫ ${wsName(w)}` }), el('span', { class: 'sc-faint', text: ` ${ps.length}` })));
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

export function renderAllTasks(root) {
  clear(root);
  if (!loaded && !loading) void reloadAllTasks();
  const pane = el('div', { class: 'alltasks-pane tl-pane' });
  root.append(pane);
  pane.append(projectsTasksTabs('alltasks'));
  let layout = null;
  try { layout = currentLayout(); } catch { layout = null; }
  const list = visible(layout);
  const projectCount = plans.filter((p) => (opts.completedProjects || !p.archived) && (!opts.workspace || p.workspaceId === opts.workspace)).length;
  pane.append(controls(root, opts.layout === 'gantt' ? projectCount : list.length));
  if (loading && !loaded) { pane.append(el('p', { class: 'empty', text: 'Reading every plan on the shelf…' })); return; }
  if (opts.layout === 'gantt') { pane.append(ganttLayout(root)); return; }
  if (!list.length) { pane.append(el('p', { class: 'empty', text: rows.length ? 'No task matches. “Show resolved tasks” brings back the finished ones.' : 'No plans on the shelf yet.' })); return; }
  pane.append(opts.layout === 'kanban' ? kanbanLayout(list, root) : listLayout(list, root, layout));
}
