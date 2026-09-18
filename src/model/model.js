// The plan: an ordered list of tasks with outline levels (as Microsoft Project
// keeps them), resources, and assignments living on the tasks.
//
// A summary task is any task followed by a task of a deeper level; its dates
// are never stored, only computed from its children (see schedule.js).
// Everything here is DOM-free so tests and a future CLI can use it.

import { uid } from '../util.js';
import { DEFAULT_CALENDAR, parseDuration, isoValid, toDay, fromDay, makeCalendar } from './calendar.js';

export const FORMAT = 'project-planner';
export const VERSION = 1;

export const LINK_TYPES = { FS: 'Finish-to-Start', SS: 'Start-to-Start', FF: 'Finish-to-Finish', SF: 'Start-to-Finish' };
export const CONSTRAINTS = {
  ASAP: { label: 'As Soon As Possible', dated: false },
  SNET: { label: 'Start No Earlier Than', dated: true },
  SNLT: { label: 'Start No Later Than', dated: true },
  FNET: { label: 'Finish No Earlier Than', dated: true },
  FNLT: { label: 'Finish No Later Than', dated: true },
  MSO: { label: 'Must Start On', dated: true },
  MFO: { label: 'Must Finish On', dated: true },
};
export const RESOURCE_TYPES = { work: 'Work', material: 'Material', cost: 'Cost' };

export function createProject(name = 'Untitled project', start = null) {
  return {
    format: FORMAT, version: VERSION, name, start: start || fromDay(Math.floor(Date.now() / 86400000)), statusDate: null,
    currency: '$', calendar: { ...DEFAULT_CALENDAR, holidays: [] }, tasks: [], resources: [],
  };
}

export function newTask(props = {}) {
  return {
    id: uid('t'), name: 'New task', level: 1, duration: 1, milestone: false, predecessors: [],
    constraint: { type: 'ASAP', date: null }, deadline: null, percent: 0, notes: '', assignments: [], fixedCost: 0, ...props,
  };
}
export function newResource(props = {}) {
  return { id: uid('r'), name: 'New resource', initials: '', type: 'work', maxUnits: 1, rate: 0, group: '', ...props };
}

// ---------------------------------------------------------------- outline

export const taskIndex = (p, id) => p.tasks.findIndex((t) => t.id === id);
export const getTask = (p, id) => p.tasks.find((t) => t.id === id) || null;
export const getResource = (p, id) => p.resources.find((r) => r.id === id) || null;

export const isSummary = (p, i) => i >= 0 && i < p.tasks.length - 1 && p.tasks[i + 1].level > p.tasks[i].level;
export const isSummaryTask = (p, id) => isSummary(p, taskIndex(p, id));

/** Indices of every task under task i. */
export function descendants(p, i) {
  const out = [];
  const lvl = p.tasks[i].level;
  for (let j = i + 1; j < p.tasks.length && p.tasks[j].level > lvl; j++) out.push(j);
  return out;
}
/** Indices of the direct children of task i. */
export function childrenOf(p, i) {
  const lvl = p.tasks[i].level;
  return descendants(p, i).filter((j) => p.tasks[j].level === lvl + 1);
}
export function parentIndex(p, i) {
  const lvl = p.tasks[i].level;
  for (let j = i - 1; j >= 0; j--) if (p.tasks[j].level < lvl) return j;
  return -1;
}
export function ancestors(p, i) {
  const out = [];
  for (let j = parentIndex(p, i); j >= 0; j = parentIndex(p, j)) out.push(j);
  return out;
}
export const isAncestor = (p, a, i) => ancestors(p, i).includes(a);

/** WBS codes ('1.2.3') for every task, in order. */
export function wbsCodes(p) {
  const counters = [];
  return p.tasks.map((t) => {
    counters.length = t.level;
    counters[t.level - 1] = (counters[t.level - 1] || 0) + 1;
    for (let l = 0; l < t.level - 1; l++) counters[l] = counters[l] || 1;
    return counters.join('.');
  });
}

/** Levels must start at 1 and never jump by more than one. Returns repairs made. */
export function normalizeLevels(p) {
  const repairs = [];
  let prev = 0;
  p.tasks.forEach((t, i) => {
    const lvl = Math.max(1, Math.floor(Number(t.level) || 1));
    const max = prev + 1;
    const fixed = Math.min(lvl, max);
    if (fixed !== t.level) { repairs.push(`Task ${i + 1} “${t.name}”: outline level ${t.level} → ${fixed}.`); t.level = fixed; }
    prev = fixed;
  });
  return repairs;
}

// ---------------------------------------------------------------- editing tasks

/** Insert a task before index `at` (or at the end), at the level of the task that was there. */
export function insertTask(p, at = p.tasks.length, props = {}) {
  const i = Math.max(0, Math.min(at, p.tasks.length));
  const ref = p.tasks[i] || p.tasks[i - 1];
  const level = props.level || (ref ? (i < p.tasks.length ? ref.level : ref.level) : 1);
  const t = newTask({ ...props, level });
  p.tasks.splice(i, 0, t);
  return t;
}

/** Remove tasks and everything under them; links to them are dropped. */
export function removeTasks(p, ids) {
  const gone = new Set();
  for (const id of ids) {
    const i = taskIndex(p, id);
    if (i < 0) continue;
    gone.add(id);
    for (const j of descendants(p, i)) gone.add(p.tasks[j].id);
  }
  p.tasks = p.tasks.filter((t) => !gone.has(t.id));
  for (const t of p.tasks) t.predecessors = t.predecessors.filter((l) => !gone.has(l.id));
  return gone.size;
}

export function indentTasks(p, ids) {
  let changed = 0;
  // Top to bottom: a task can only go one deeper than the task above it.
  for (const i of ids.map((id) => taskIndex(p, id)).filter((i) => i > 0).sort((a, b) => a - b)) {
    const t = p.tasks[i];
    if (t.level > p.tasks[i - 1].level) continue;
    for (const j of descendants(p, i)) p.tasks[j].level++;
    t.level++;
    changed++;
  }
  return changed;
}
export function outdentTasks(p, ids) {
  let changed = 0;
  for (const i of ids.map((id) => taskIndex(p, id)).filter((i) => i >= 0).sort((a, b) => b - a)) {
    const t = p.tasks[i];
    if (t.level <= 1) continue;
    for (const j of descendants(p, i)) p.tasks[j].level--;
    t.level--;
    changed++;
  }
  normalizeLevels(p);
  return changed;
}

/** Move a task (with its subtasks) over the sibling block above or below it. */
export function moveTask(p, id, dir) {
  const i = taskIndex(p, id);
  if (i < 0) return false;
  const block = [i, ...descendants(p, i)];
  const items = block.map((j) => p.tasks[j]);
  if (dir < 0) {
    // the block above: walk up to the previous task at the same level (or shallower)
    let j = i - 1;
    if (j < 0 || p.tasks[j].level < p.tasks[i].level) return false;
    while (j > 0 && p.tasks[j].level > p.tasks[i].level) j--;
    if (p.tasks[j].level !== p.tasks[i].level) return false;
    p.tasks.splice(i, block.length);
    p.tasks.splice(j, 0, ...items);
  } else {
    const after = i + block.length;
    if (after >= p.tasks.length || p.tasks[after].level < p.tasks[i].level) return false;
    const next = [after, ...descendants(p, after)];
    p.tasks.splice(i, block.length);
    p.tasks.splice(i + next.length, 0, ...items);
  }
  return true;
}

// ---------------------------------------------------------------- links

/**
 * Dependency graph, the scheduler's and the cycle check's shared truth:
 * `deps.get(id)` is the set of task ids whose dates must be known first.
 *   - a task's predecessors, and its ancestors' predecessors (they bound it too)
 *   - a summary's children (its dates are theirs)
 */
export function dependencyGraph(p) {
  const deps = new Map();
  p.tasks.forEach((t, i) => {
    const set = new Set();
    for (const l of t.predecessors) set.add(l.id);
    for (const a of ancestors(p, i)) for (const l of p.tasks[a].predecessors) set.add(l.id);
    if (isSummary(p, i)) for (const c of childrenOf(p, i)) set.add(p.tasks[c].id);
    deps.set(t.id, set);
  });
  return deps;
}

/** Kahn's algorithm. Returns { order, cyclic: ids left over }. */
export function topoOrder(p, deps = dependencyGraph(p)) {
  const indeg = new Map(), users = new Map();
  for (const t of p.tasks) { indeg.set(t.id, 0); users.set(t.id, []); }
  for (const [id, set] of deps) for (const d of set) {
    if (!indeg.has(d)) continue;
    indeg.set(id, indeg.get(id) + 1);
    users.get(d).push(id);
  }
  const queue = p.tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const u of users.get(id)) { indeg.set(u, indeg.get(u) - 1); if (indeg.get(u) === 0) queue.push(u); }
  }
  const done = new Set(order);
  return { order, cyclic: p.tasks.map((t) => t.id).filter((id) => !done.has(id)) };
}

export function linkError(p, fromId, toId) {
  if (fromId === toId) return 'A task cannot depend on itself.';
  const a = taskIndex(p, fromId), b = taskIndex(p, toId);
  if (a < 0 || b < 0) return 'No such task.';
  if (isAncestor(p, a, b) || isAncestor(p, b, a)) return 'A summary task and one of its own subtasks cannot be linked.';
  const trial = { ...p, tasks: p.tasks.map((t) => (t.id === toId ? { ...t, predecessors: [...t.predecessors.filter((l) => l.id !== fromId), { id: fromId, type: 'FS', lag: 0 }] } : t)) };
  if (topoOrder(trial).cyclic.length) return `Linking ${a + 1} → ${b + 1} would make a circular dependency.`;
  return null;
}

export function link(p, fromId, toId, type = 'FS', lag = 0) {
  const err = linkError(p, fromId, toId);
  if (err) throw new Error(err);
  if (!LINK_TYPES[type]) throw new Error(`Unknown link type ${type}.`);
  const t = getTask(p, toId);
  t.predecessors = t.predecessors.filter((l) => l.id !== fromId);
  t.predecessors.push({ id: fromId, type, lag: Number(lag) || 0 });
}
export function unlink(p, fromId, toId) {
  const t = getTask(p, toId);
  if (t) t.predecessors = t.predecessors.filter((l) => l.id !== fromId);
}
/** Link a selection in order: 1→2→3. */
export function linkChain(p, ids) {
  const idx = ids.map((id) => taskIndex(p, id)).filter((i) => i >= 0).sort((a, b) => a - b);
  let n = 0;
  for (let k = 1; k < idx.length; k++) {
    const from = p.tasks[idx[k - 1]].id, to = p.tasks[idx[k]].id;
    if (p.tasks[idx[k]].predecessors.some((l) => l.id === from)) continue;
    if (!linkError(p, from, to)) { link(p, from, to); n++; }
  }
  return n;
}
export function unlinkAll(p, ids) {
  const set = new Set(ids);
  let n = 0;
  for (const t of p.tasks) {
    if (set.has(t.id)) { n += t.predecessors.length; t.predecessors = []; }
    else { const before = t.predecessors.length; t.predecessors = t.predecessors.filter((l) => !set.has(l.id)); n += before - t.predecessors.length; }
  }
  return n;
}

/** '3FS+2d, 5SS-1d, 7' (row numbers) → links. Throws on anything it cannot read. */
export function parsePredecessors(p, text, forId) {
  const out = [];
  for (const part of String(text || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*(FS|SS|FF|SF)?\s*(?:([+-])\s*(\d+(?:\.\d+)?)\s*(d|w|h)?)?$/i);
    if (!m) throw new Error(`“${part}” is not a predecessor. Use forms like 3, 3FS+2d or 5SS-1d.`);
    const row = +m[1];
    const pred = p.tasks[row - 1];
    if (!pred) throw new Error(`There is no task ${row}.`);
    const type = (m[2] || 'FS').toUpperCase();
    let lag = m[4] ? parseDuration(m[4] + (m[5] || 'd'), p.calendar.hoursPerDay) : 0;
    if (m[3] === '-') lag = -lag;
    if (forId) { const err = linkError(p, pred.id, forId); if (err) throw new Error(err); }
    if (!out.some((l) => l.id === pred.id)) out.push({ id: pred.id, type, lag });
  }
  return out;
}
export function formatPredecessors(p, task) {
  return task.predecessors.map((l) => {
    const i = taskIndex(p, l.id);
    if (i < 0) return null;
    const lag = l.lag ? `${l.lag > 0 ? '+' : '-'}${Math.abs(l.lag)}d` : '';
    return `${i + 1}${l.type === 'FS' && !lag ? '' : l.type}${lag}`;
  }).filter(Boolean).join(', ');
}

// ---------------------------------------------------------------- resources

export function addResource(p, props = {}) {
  const r = newResource(props);
  if (!r.initials) r.initials = r.name.split(/\s+/).map((w) => w[0] || '').join('').toUpperCase().slice(0, 3);
  p.resources.push(r);
  return r;
}
export function removeResource(p, id) {
  p.resources = p.resources.filter((r) => r.id !== id);
  for (const t of p.tasks) t.assignments = t.assignments.filter((a) => a.resourceId !== id);
}
export function assign(p, taskId, resourceId, units = 1) {
  const t = getTask(p, taskId);
  if (!t || !getResource(p, resourceId)) throw new Error('No such task or resource.');
  const a = t.assignments.find((x) => x.resourceId === resourceId);
  if (a) a.units = units; else t.assignments.push({ resourceId, units });
}
export function unassign(p, taskId, resourceId) {
  const t = getTask(p, taskId);
  if (t) t.assignments = t.assignments.filter((a) => a.resourceId !== resourceId);
}

/** 'Ana [50%], Ben' → assignments; unknown names become new work resources. */
export function parseAssignments(p, text) {
  const out = [];
  for (const part of String(text || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(.*?)\s*(?:\[\s*(\d+(?:\.\d+)?)\s*%?\s*\])?$/);
    const name = m[1].trim();
    if (!name) continue;
    let r = p.resources.find((x) => x.name.toLowerCase() === name.toLowerCase() || (x.initials && x.initials.toLowerCase() === name.toLowerCase()));
    if (!r) r = addResource(p, { name });
    const units = m[2] ? +m[2] / 100 : 1;
    if (!out.some((a) => a.resourceId === r.id)) out.push({ resourceId: r.id, units });
  }
  return out;
}
export function formatAssignments(p, task) {
  return task.assignments.map((a) => {
    const r = getResource(p, a.resourceId);
    if (!r) return null;
    return a.units === 1 ? r.name : `${r.name} [${Math.round(a.units * 100)}%]`;
  }).filter(Boolean).join(', ');
}

// ---------------------------------------------------------------- field edits

/**
 * Set a field from user text. Understands the grid's column keys; validates
 * and normalises. Throws with a readable message.
 */
export function setTaskField(p, id, field, value) {
  const t = getTask(p, id);
  if (!t) throw new Error('No such task.');
  switch (field) {
    case 'name': t.name = String(value).trim() || 'Untitled task'; break;
    case 'duration': {
      const d = typeof value === 'number' ? value : parseDuration(value, p.calendar.hoursPerDay);
      t.duration = d;
      t.milestone = d === 0;
      break;
    }
    case 'milestone': t.milestone = !!value; if (t.milestone) t.duration = 0; else if (t.duration === 0) t.duration = 1; break;
    case 'start': {
      // As in Microsoft Project, typing a start date pins the task with a Start No Earlier Than constraint.
      if (!value) { t.constraint = { type: 'ASAP', date: null }; break; }
      if (!isoValid(value)) throw new Error(`“${value}” is not a date (use YYYY-MM-DD).`);
      t.constraint = { type: t.constraint.type === 'MSO' ? 'MSO' : 'SNET', date: value };
      break;
    }
    case 'finish': throw new Error('Use setFinish(): a finish date needs the scheduled start.');
    case 'percent': {
      const n = Math.round(parseFloat(String(value).replace('%', '')));
      if (Number.isNaN(n) || n < 0 || n > 100) throw new Error('Percent complete is a number from 0 to 100.');
      t.percent = n;
      break;
    }
    case 'predecessors': t.predecessors = parsePredecessors(p, value, id); break;
    case 'resources': t.assignments = parseAssignments(p, value); break;
    case 'notes': t.notes = String(value ?? ''); break;
    case 'deadline': if (value && !isoValid(value)) throw new Error('A deadline is a date (YYYY-MM-DD).'); t.deadline = value || null; break;
    case 'constraintType': {
      if (!CONSTRAINTS[value]) throw new Error('Unknown constraint.');
      t.constraint = { type: value, date: CONSTRAINTS[value].dated ? (t.constraint.date || p.start) : null };
      break;
    }
    case 'constraintDate': if (value && !isoValid(value)) throw new Error('A constraint date is a date (YYYY-MM-DD).'); t.constraint.date = value || null; if (!value) t.constraint.type = 'ASAP'; break;
    case 'fixedCost': { const n = parseFloat(String(value).replace(/[^0-9.-]/g, '')); if (Number.isNaN(n)) throw new Error('Fixed cost is a number.'); t.fixedCost = n; break; }
    default: throw new Error(`“${field}” cannot be edited here.`);
  }
}

/** Set a finish date given the task's scheduled start: the duration changes. */
export function setFinish(p, id, startIso, finishIso) {
  const t = getTask(p, id);
  if (!isoValid(finishIso)) throw new Error(`“${finishIso}” is not a date (use YYYY-MM-DD).`);
  const cal = makeCalendar(p.calendar);
  const a = toDay(startIso), b = toDay(finishIso);
  if (b < a) throw new Error('The finish date is before the start date.');
  t.duration = Math.max(t.milestone ? 0 : 1, cal.between(a, b));
  if (t.duration > 0) t.milestone = false;
}

export function setResourceField(p, id, field, value) {
  const r = getResource(p, id);
  if (!r) throw new Error('No such resource.');
  switch (field) {
    case 'name': r.name = String(value).trim() || 'Unnamed'; break;
    case 'initials': r.initials = String(value).trim().toUpperCase().slice(0, 4); break;
    case 'type': if (!RESOURCE_TYPES[value]) throw new Error('Unknown resource type.'); r.type = value; break;
    case 'maxUnits': { const n = parseFloat(String(value).replace('%', '')); if (Number.isNaN(n) || n < 0) throw new Error('Max units is a percentage.'); r.maxUnits = n > 5 ? n / 100 : n; break; }
    case 'rate': { const n = parseFloat(String(value).replace(/[^0-9.-]/g, '')); if (Number.isNaN(n)) throw new Error('A rate is a number.'); r.rate = n; break; }
    case 'group': r.group = String(value).trim(); break;
    default: throw new Error(`“${field}” cannot be edited here.`);
  }
}
