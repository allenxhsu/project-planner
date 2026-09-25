// The plan: an ordered list of tasks with outline levels (as Microsoft Project
// keeps them), resources, and assignments living on the tasks.
//
// A summary task is any task followed by a task of a deeper level; its dates
// are never stored, only computed from its children (see schedule.js).
// Everything here is DOM-free so tests and a future CLI can use it.

import { uid } from '../util.js';
import { DEFAULT_CALENDAR, parseDuration, isoValid, toDay, fromDay, makeCalendar } from './calendar.js';
import { BLOCK_CHOICES, parseTime } from './agenda.js';

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

/**
 * How urgent a task is, as a person judges it — which the dates cannot say.
 *
 * The schedule knows what is late and what has no slack; it does not know that
 * this one matters more than that one. Urgency is that judgement, and it
 * decides who gets the earliest hours when two tasks want the same morning.
 * `now` is the override: it goes first, today, ahead of everything.
 */
export const URGENCIES = {
  now: { label: 'Do it now', rank: 0, weight: 400 },
  high: { label: 'High', rank: 1, weight: 120 },
  normal: { label: 'Normal', rank: 2, weight: 0 },
  low: { label: 'Low', rank: 3, weight: -60 },
};
export const urgencyOf = (task) => (URGENCIES[task?.urgency] ? task.urgency : 'normal');

/**
 * Kanban stages: the plan's own columns, the way a board has them.
 *
 * A stage says where a task stands in the way this team works; `done` marks
 * the columns that mean finished, so the board and the schedule cannot drift
 * apart — dropping a task in a done column completes it, and completing a task
 * puts it there.
 */
export const DEFAULT_STAGES = [
  { id: 'stage_todo', name: 'To do', done: false },
  { id: 'stage_doing', name: 'In progress', done: false },
  { id: 'stage_done', name: 'Done', done: true },
];
export const newStage = (name = 'New stage', done = false) => ({ id: uid('stage'), name, done });

export function createProject(name = 'Untitled project', start = null) {
  return {
    // The id travels with the plan and never changes: it is what sync uses to
    // know that this plan and the one on another device are the same plan.
    id: uid('plan'),
    format: FORMAT, version: VERSION, name, start: start || fromDay(Math.floor(Date.now() / 86400000)), statusDate: null,
    currency: '$', calendar: { ...DEFAULT_CALENDAR, holidays: [] },
    stages: DEFAULT_STAGES.map((st) => ({ ...st })),
    timeBlocks: DEFAULT_TIME_BLOCKS.map((b) => ({ ...b, days: [...b.days] })), currentPhaseId: null, feeds: [],
    agenda: { blockHours: 1, timeBlockId: 'tb_work', gapMinutes: 0, assumedLoad: 50, dailyCap: 6 },
    // The hue this project is drawn in on a shared calendar. Null means the
    // calendar picks one, spaced away from the projects beside it.
    colour: null,
    // A template is a pattern to copy, not work in anyone's week.
    template: false,
    // Archived: finished or shelved. Kept in full, but out of the way of
    // everything that asks what is being worked on now.
    archived: false, archivedAt: null,
    tasks: [], resources: [], timesheets: [],
  };
}

export function newTask(props = {}) {
  return {
    id: uid('t'), name: 'New task', level: 1, duration: 1, milestone: false, predecessors: [],
    constraint: { type: 'ASAP', date: null }, deadline: null, percent: 0, notes: '', assignments: [], fixedCost: 0,
    // Hours of effort. Duration is how long the task is open — five days for a
    // design task — and work is how much of that time is spent on it. Null
    // means "as much as the assignment says", the old full-time assumption.
    work: null,
    stageId: null, urgency: 'normal',
    // Calendar: off until asked for. `blockHours`, `from` and `to` fall back to
    // the plan's own defaults, so most tasks carry nothing but `show`.
    calendar: { show: false, timeBlockId: null },
    ...props,
  };
}
export function newResource(props = {}) {
  // `personId` is who this is across the whole shelf. A plan still carries the
  // name and the rate, so a `.project.json` on its own is still a whole plan —
  // but two plans with the same person now agree on one id rather than only on
  // a spelling.
  return { id: uid('r'), personId: null, name: 'New resource', initials: '', type: 'work', maxUnits: 1, rate: 0, group: '', ...props };
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
  if (Array.isArray(p.timesheets)) p.timesheets = p.timesheets.filter((x) => !gone.has(x.taskId));
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
  // The same person is never added twice to one plan.
  const already = props.personId ? p.resources.find((r) => r.personId === props.personId) : null;
  if (already) return already;
  const r = newResource(props);
  if (!r.initials) r.initials = r.name.split(/\s+/).map((w) => w[0] || '').join('').toUpperCase().slice(0, 3);
  p.resources.push(r);
  return r;
}

/** Who this resource is, across plans: the shared person, or failing that the name. */
export const identityOf = (r) => (r?.personId ? `person:${r.personId}` : `who:${String(r?.name || '').trim().toLowerCase()}`);
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

// ---------------------------------------------------------------- calendars
//
// A connected calendar: Google's or Outlook's private ICS address. The events
// are kept with the plan, so they travel with it and every device sees the
// same busy hours without each one needing the address.

export const PROVIDERS = { google: 'Google Calendar', outlook: 'Outlook', ics: 'Other (iCalendar)' };

export function addFeed(p, { name = 'My calendar', url = '', provider = 'ics', resourceId = null } = {}) {
  if (!Array.isArray(p.feeds)) p.feeds = [];
  if (!/^https?:\/\//i.test(String(url).trim()) && !/^webcal:\/\//i.test(String(url).trim())) {
    throw new Error('A calendar address starts with https:// (Google and Outlook both give you one).');
  }
  if (resourceId && !getResource(p, resourceId)) throw new Error('No such resource.');
  const feed = {
    id: uid('feed'), name: String(name).trim() || 'My calendar',
    url: String(url).trim().replace(/^webcal:/i, 'https:'),
    provider: PROVIDERS[provider] ? provider : 'ics',
    resourceId: resourceId || null, fetchedAt: null, events: [],
  };
  p.feeds.push(feed);
  return feed;
}

export const feeds = (p) => (Array.isArray(p.feeds) ? p.feeds : []);
export const getFeed = (p, id) => feeds(p).find((f) => f.id === id) || null;
export function removeFeed(p, id) { p.feeds = feeds(p).filter((f) => f.id !== id); }
export function setFeedField(p, id, field, value) {
  const f = getFeed(p, id);
  if (!f) throw new Error('No such calendar.');
  if (field === 'name') f.name = String(value).trim() || f.name;
  else if (field === 'resourceId') { if (value && !getResource(p, value)) throw new Error('No such resource.'); f.resourceId = value || null; }
  else if (field === 'url') { if (!/^https?:\/\//i.test(String(value).trim())) throw new Error('A calendar address starts with https://.'); f.url = String(value).trim(); f.events = []; f.fetchedAt = null; }
  else throw new Error(`“${field}” is not part of a calendar.`);
}

/** Put freshly read events on a feed. Only the busy ones are worth keeping. */
export function setFeedEvents(p, id, events, at = Date.now()) {
  const f = getFeed(p, id);
  if (!f) throw new Error('No such calendar.');
  f.events = (events || []).filter((e) => e.busy !== false).map((e) => ({
    uid: String(e.uid || ''), title: String(e.title || '(no title)'),
    start: +e.start, end: +e.end, allDay: !!e.allDay,
  })).filter((e) => Number.isFinite(e.start) && Number.isFinite(e.end) && e.end > e.start);
  f.fetchedAt = at;
  return f.events.length;
}

// ---------------------------------------------------------------- phases
//
// A phase is a top-level summary task — Discovery, Design, Build, Launch. When
// a plan says which phase it is in, the calendar releases only that phase's
// work: there is no point putting build tasks in next week's mornings while
// the design is still being argued about.

/** The top-level summary a task belongs to, or null for a task at the top. */
export function phaseOf(p, taskId) {
  const i = taskIndex(p, taskId);
  if (i < 0) return null;
  const top = [...ancestors(p, i)].pop();
  return top === undefined ? null : p.tasks[top].id;
}

/** Every top-level summary, in order: the phases a plan can be in. */
export function phases(p) {
  return p.tasks.filter((t, i) => t.level === 1 && isSummary(p, i)).map((t) => ({ id: t.id, name: t.name }));
}

/** Whether this task's phase is the one being worked on. No phase set: everything. */
export function inCurrentPhase(p, taskId) {
  if (!p.currentPhaseId) return true;
  if (!getTask(p, p.currentPhaseId)) return true;
  return phaseOf(p, taskId) === p.currentPhaseId;
}

// ---------------------------------------------------------------- time blocks
//
// The hours of the week that are for a kind of work: "Study, 06:00–08:00,
// every day"; "Work, 08:00–17:00, weekdays"; "Deep focus, 08:00–10:00,
// weekdays". A task says which block it belongs to and the calendar releases
// it into those hours by itself, rather than asking for a time per task.

export const DEFAULT_TIME_BLOCKS = [
  { id: 'tb_work', name: 'Work', from: '08:00', to: '17:00', days: [1, 2, 3, 4, 5] },
  { id: 'tb_focus', name: 'Deep focus', from: '08:00', to: '10:00', days: [1, 2, 3, 4, 5] },
];
export const timeBlocks = (p) => (Array.isArray(p.timeBlocks) && p.timeBlocks.length ? p.timeBlocks : DEFAULT_TIME_BLOCKS);
export const getTimeBlock = (p, id) => timeBlocks(p).find((b) => b.id === id) || null;

export function addTimeBlock(p, props = {}) {
  if (!Array.isArray(p.timeBlocks) || !p.timeBlocks.length) p.timeBlocks = DEFAULT_TIME_BLOCKS.map((b) => ({ ...b, days: [...b.days] }));
  const block = { id: uid('tb'), name: 'New block', from: '09:00', to: '17:00', days: [1, 2, 3, 4, 5], ...props };
  validateBlock(block);
  p.timeBlocks.push(block);
  return block;
}

function validateBlock(b) {
  if (parseTime(b.from) === null || parseTime(b.to) === null) throw new Error('A time of day looks like 09:00.');
  if (parseTime(b.to) <= parseTime(b.from)) throw new Error('A time block has to end after it starts.');
  if (!Array.isArray(b.days) || !b.days.length) throw new Error('A time block needs at least one day.');
}

export function setTimeBlockField(p, id, field, value) {
  const b = getTimeBlock(p, id);
  if (!b) throw new Error('No such time block.');
  const next = { ...b };
  if (field === 'name') next.name = String(value).trim() || b.name;
  else if (field === 'from' || field === 'to') next[field] = String(value).trim();
  else if (field === 'days') next.days = [...new Set((value || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
  else throw new Error(`“${field}” is not part of a time block.`);
  validateBlock(next);
  Object.assign(b, next);
}

/** Remove a block; tasks in it fall back to the plan's default block. */
export function removeTimeBlock(p, id) {
  const list = timeBlocks(p);
  if (list.length <= 1) throw new Error('There has to be one time block left.');
  p.timeBlocks = list.filter((b) => b.id !== id);
  for (const t of p.tasks) if (t.calendar?.timeBlockId === id) t.calendar = { ...t.calendar, timeBlockId: null };
  if (p.agenda?.timeBlockId === id) p.agenda = { ...p.agenda, timeBlockId: p.timeBlocks[0].id };
}

/**
 * Cut a task into subtasks — the way a week of "design the layout" is really
 * several days of different work.
 *
 * The task becomes a summary (its own duration then comes from its children,
 * as every summary's does) and the parts divide its duration between them.
 * Resources and the calendar settings come along, because the parts are the
 * same work; links stay on the parent, because that is where they belong.
 *
 * The parts run one after another by default. Left unlinked they would all
 * start on the same morning, which would say the same person does three things
 * at once and would shrink the task to a third of its length — `chain: false`
 * is there for the case where they really are parallel.
 */
export function breakIntoSubtasks(p, taskId, parts, names = [], { chain = true } = {}) {
  const i = taskIndex(p, taskId);
  if (i < 0) throw new Error('No such task.');
  if (isSummary(p, i)) throw new Error('That task already has subtasks.');
  const n = Math.max(2, Math.min(24, Math.floor(parts) || 2));
  const parent = p.tasks[i];
  const each = Math.max(0.25, Math.round((parent.duration / n) * 100) / 100);
  const made = [];
  for (let k = 0; k < n; k++) {
    made.push(newTask({
      name: (names[k] || '').trim() || `${parent.name} ${k + 1}`,
      level: parent.level + 1, duration: each,
      work: parent.work == null ? null : Math.round((parent.work / n) * 100) / 100,
      assignments: parent.assignments.map((a) => ({ ...a })),
      calendar: { ...parent.calendar },
      stageId: parent.stageId,
    }));
  }
  p.tasks.splice(i + 1, 0, ...made);
  if (chain) for (let k = 1; k < made.length; k++) made[k].predecessors = [{ id: made[k - 1].id, type: 'FS', lag: 0 }];
  // The parent keeps its links and its deadline; the rest is now its children's.
  parent.percent = 0;
  parent.milestone = false;
  parent.work = null;   // a summary's work is its children's, added up
  return made;
}

// ---------------------------------------------------------------- timesheets
//
// Work is what the plan *expects* a task to take; a timesheet line is what
// somebody actually spent. Keeping them apart is the whole point: the
// difference between the two is the only honest way to say whether an estimate
// was any good, and it is what "remaining" means.

export function newTimesheet(props = {}) {
  return { id: uid('ts'), taskId: null, resourceId: null, date: null, hours: 0, note: '', ...props };
}

export function addTimesheet(p, props = {}) {
  if (!Array.isArray(p.timesheets)) p.timesheets = [];
  const t = getTask(p, props.taskId);
  if (!t) throw new Error('A timesheet line belongs to a task.');
  if (props.resourceId && !getResource(p, props.resourceId)) throw new Error('No such resource.');
  const hours = Number(props.hours);
  if (!Number.isFinite(hours) || hours < 0) throw new Error('Hours is a number, and never negative.');
  if (props.date && !isoValid(props.date)) throw new Error('A timesheet date is a date (YYYY-MM-DD).');
  const line = newTimesheet({ ...props, hours: Math.round(hours * 100) / 100 });
  p.timesheets.push(line);
  return line;
}

export function removeTimesheet(p, id) {
  p.timesheets = (p.timesheets || []).filter((x) => x.id !== id);
}

export function setTimesheetField(p, id, field, value) {
  const line = (p.timesheets || []).find((x) => x.id === id);
  if (!line) throw new Error('No such timesheet line.');
  switch (field) {
    case 'hours': {
      const n = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
      if (!Number.isFinite(n) || n < 0) throw new Error('Hours is a number, and never negative.');
      line.hours = Math.round(n * 100) / 100;
      break;
    }
    case 'date': if (value && !isoValid(value)) throw new Error('A timesheet date is a date (YYYY-MM-DD).'); line.date = value || null; break;
    case 'resourceId': if (value && !getResource(p, value)) throw new Error('No such resource.'); line.resourceId = value || null; break;
    case 'note': line.note = String(value ?? ''); break;
    default: throw new Error(`“${field}” is not part of a timesheet line.`);
  }
}

export const timesheetsFor = (p, taskId) => (p.timesheets || []).filter((x) => x.taskId === taskId);
/** Hours spent on one task, its own lines only. */
export const spentOn = (p, taskId) => timesheetsFor(p, taskId).reduce((sum, x) => sum + (Number(x.hours) || 0), 0);

// ---------------------------------------------------------------- stages

export const stages = (p) => (Array.isArray(p.stages) && p.stages.length ? p.stages : DEFAULT_STAGES);
export const getStage = (p, id) => stages(p).find((st) => st.id === id) || null;
const firstDoneStage = (p) => stages(p).find((st) => st.done) || null;

/**
 * Which column a task sits in. A task that was never dropped anywhere is in
 * the first stage — or, if it is already complete, in the first done stage, so
 * a plan made before stages existed opens on a board that tells the truth.
 */
export function stageOf(p, task) {
  const explicit = task.stageId && getStage(p, task.stageId);
  if (explicit) return explicit;
  if ((task.percent ?? 0) === 100) return firstDoneStage(p) || stages(p)[0];
  return stages(p)[0];
}

/** Put a task in a stage. A done stage completes it; that is what done means. */
export function setStage(p, taskId, stageId) {
  const t = getTask(p, taskId);
  const st = getStage(p, stageId);
  if (!t || !st) throw new Error('No such task or stage.');
  t.stageId = st.id;
  if (st.done) { t.percent = 100; if (t.milestone) t.duration = 0; }
}

export function addStage(p, name = 'New stage') {
  if (!Array.isArray(p.stages) || !p.stages.length) p.stages = DEFAULT_STAGES.map((st) => ({ ...st }));
  const st = newStage(String(name).trim() || 'New stage');
  // Before the done columns: a new column is somewhere work passes through.
  const at = p.stages.findIndex((x) => x.done);
  p.stages.splice(at < 0 ? p.stages.length : at, 0, st);
  return st;
}

export function renameStage(p, id, name) {
  const st = getStage(p, id);
  if (!st) throw new Error('No such stage.');
  st.name = String(name).trim() || st.name;
}

export function setStageDone(p, id, done) {
  const st = getStage(p, id);
  if (!st) throw new Error('No such stage.');
  if (!done && stages(p).filter((x) => x.done).length === 1 && st.done) throw new Error('A board needs one column that means finished.');
  st.done = !!done;
  if (st.done) for (const t of p.tasks) if (t.stageId === st.id) t.percent = 100;
}

/** Remove a stage; its tasks fall back to the first one. */
export function removeStage(p, id) {
  const list = stages(p);
  if (list.length <= 1) throw new Error('A board needs at least one column.');
  const st = getStage(p, id);
  if (!st) return;
  p.stages = list.filter((x) => x.id !== id);
  const fallback = p.stages[0].id;
  for (const t of p.tasks) if (t.stageId === id) t.stageId = fallback;
}

export function moveStage(p, id, dir) {
  const list = stages(p);
  const i = list.findIndex((x) => x.id === id);
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return false;
  p.stages = [...list];
  [p.stages[i], p.stages[j]] = [p.stages[j], p.stages[i]];
  return true;
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
    case 'work': {
      const raw = String(value).trim();
      if (!raw) { t.work = null; break; }          // back to whatever the assignment implies
      const m = /^(\d+(?:[.,]\d+)?)\s*(h|hr|hrs|hour|hours|d|day|days)?$/i.exec(raw);
      if (!m) throw new Error('Work is a number of hours, like 12 or 12h (or 2d).');
      const n = parseFloat(m[1].replace(',', '.'));
      const unit = (m[2] || 'h').toLowerCase();
      t.work = Math.round((unit.startsWith('d') ? n * (p.calendar?.hoursPerDay || 8) : n) * 100) / 100;
      break;
    }
    case 'percent': {
      const n = Math.round(parseFloat(String(value).replace('%', '')));
      if (Number.isNaN(n) || n < 0 || n > 100) throw new Error('Percent complete is a number from 0 to 100.');
      const wasDone = getStage(p, t.stageId)?.done ?? false;
      t.percent = n;
      // Completing a task moves it to the finished column, and taking it back
      // off 100% moves it out of one — otherwise the board would lie.
      if (n === 100 && !wasDone) { const done = firstDoneStage(p); if (done) t.stageId = done.id; }
      if (n < 100 && wasDone) t.stageId = stages(p).find((st) => !st.done)?.id ?? null;
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
    case 'urgency': {
      if (!URGENCIES[value]) throw new Error(`Urgency is one of ${Object.keys(URGENCIES).join(', ')}.`);
      t.urgency = value;
      // "Do it now" only means anything if the task is on the calendar at all.
      if (value === 'now') t.calendar = { ...t.calendar, show: true };
      break;
    }
    case 'calendarShow': t.calendar = { ...t.calendar, show: !!value }; break;
    case 'blockHours': {
      const n = parseFloat(value);
      if (!BLOCK_CHOICES.includes(n)) throw new Error(`A block is one of ${BLOCK_CHOICES.join(', ')} hours.`);
      t.calendar = { ...t.calendar, blockHours: n };
      break;
    }
    case 'timeBlock': {
      if (value && !getTimeBlock(p, value)) throw new Error('No such time block.');
      t.calendar = { ...t.calendar, timeBlockId: value || null };
      break;
    }
    case 'calendarFrom': case 'calendarTo': {
      if (value && parseTime(value) === null) throw new Error('A time of day looks like 09:00.');
      t.calendar = { ...t.calendar, [field === 'calendarFrom' ? 'from' : 'to']: value || null };
      const a = { from: parseTime(t.calendar.from), to: parseTime(t.calendar.to) };
      if (a.from !== null && a.to !== null && a.to <= a.from) throw new Error('The day has to end after it starts.');
      break;
    }
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
    case 'personId': r.personId = value || null; break;
    default: throw new Error(`“${field}” cannot be edited here.`);
  }
}
