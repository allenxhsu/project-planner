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
    // The phases this plan runs through, named by hand. Empty: no gating.
    phases: [],
    // Custom fields: columns a plan adds for itself — a client, a budget
    // code, a link to the brief. Each task keeps its values in `fields`.
    fields: [],
    timeBlocks: DEFAULT_TIME_BLOCKS.map((b) => ({ ...b, days: [...b.days] })), currentPhaseId: null, feeds: [],
    // Events made here, on the calendar — a dentist, a call — rather than read
    // from a connected calendar. Busy time the work goes around.
    events: [],
    agenda: { blockHours: 1, timeBlockId: 'tb_work', gapMinutes: 0, assumedLoad: 50, dailyCap: 6 },
    // Which workspace this plan lives in — work, personal, school. Null is
    // unfiled, which shows up wherever you are.
    workspaceId: null,
    // The hue this project is drawn in on a shared calendar. Null means the
    // calendar picks one, spaced away from the projects beside it.
    colour: null,
    // Kept at the top of the shelf, whatever the alphabet says.
    pinned: false,
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
    stageId: null, phaseId: null, urgency: 'normal',
    // Archived: kept, but no longer asking for anyone's time. Not the same as
    // done — nothing is claimed about whether the work happened.
    archived: false,
    // Calendar: off until asked for. `blockHours`, `from` and `to` fall back to
    // the plan's own defaults, so most tasks carry nothing but `show`.
    calendar: { show: false, timeBlockIds: [] },
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
  // A new task starts its own history, whatever it was copied from.
  delete t.activity;
  logActivity(t, { kind: 'created' });
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
    bufferMinutes: DEFAULT_BUFFER_MINUTES,
  };
  p.feeds.push(feed);
  return feed;
}

export const feeds = (p) => (Array.isArray(p.feeds) ? p.feeds : []);

/**
 * Travel time around an event that is somewhere.
 *
 * An appointment with a location needs getting to and getting back from, and
 * a calendar that lays work up to the minute it starts has claimed the twenty
 * minutes someone spends in the car. So an event with a location books this
 * much either side of it as busy. Per feed, because a work calendar full of
 * room numbers and a personal one full of addresses want different answers;
 * 0 is off.
 */
export const DEFAULT_BUFFER_MINUTES = 30;
export const BUFFER_CHOICES = [0, 10, 15, 30, 45, 60];
export const bufferOf = (feed) => (BUFFER_CHOICES.includes(+feed?.bufferMinutes) ? +feed.bufferMinutes : DEFAULT_BUFFER_MINUTES);
export const getFeed = (p, id) => feeds(p).find((f) => f.id === id) || null;
export function removeFeed(p, id) { p.feeds = feeds(p).filter((f) => f.id !== id); }
export function setFeedField(p, id, field, value) {
  const f = getFeed(p, id);
  if (!f) throw new Error('No such calendar.');
  if (field === 'name') f.name = String(value).trim() || f.name;
  else if (field === 'resourceId') { if (value && !getResource(p, value)) throw new Error('No such resource.'); f.resourceId = value || null; }
  else if (field === 'url') { if (!/^https?:\/\//i.test(String(value).trim())) throw new Error('A calendar address starts with https://.'); f.url = String(value).trim(); f.events = []; f.fetchedAt = null; }
  else if (field === 'bufferMinutes') { const n = +value; if (!BUFFER_CHOICES.includes(n)) throw new Error(`Travel time is one of ${BUFFER_CHOICES.join(', ')} minutes.`); f.bufferMinutes = n; }
  else throw new Error(`“${field}” is not part of a calendar.`);
}

/** Put freshly read events on a feed. Only the busy ones are worth keeping. */
export function setFeedEvents(p, id, events, at = Date.now()) {
  const f = getFeed(p, id);
  if (!f) throw new Error('No such calendar.');
  f.events = (events || []).filter((e) => e.busy !== false).map((e) => ({
    uid: String(e.uid || ''), title: String(e.title || '(no title)'),
    start: +e.start, end: +e.end, allDay: !!e.allDay,
    ...(e.location ? { location: String(e.location) } : {}),
    ...(e.description ? { description: String(e.description).slice(0, 2000) } : {}),
  })).filter((e) => Number.isFinite(e.start) && Number.isFinite(e.end) && e.end > e.start);
  f.fetchedAt = at;
  return f.events.length;
}

// ---------------------------------------------------------------- pins
//
// Every block the calendar shows is computed, and nothing about where it sits
// is stored — which is why logging four hours re-lays the week by itself. A
// pin is the one exception: a block someone dragged to a particular hour, kept
// on the task as { day, start, minutes } and booked before anything else is
// laid. A pin records a decision, so it outlives the layout that suggested it.

export const pinsOf = (task) => (Array.isArray(task?.calendar?.pins) ? task.calendar.pins : []);

function checkPin(pin) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(pin.day))) throw new Error('A pin needs a day like 2026-09-25.');
  const start = Math.round(+pin.start);
  const minutes = Math.round(+pin.minutes);
  if (!Number.isFinite(start) || start < 0 || start >= 24 * 60) throw new Error('A pin starts within the day.');
  if (!Number.isFinite(minutes) || minutes < 5 || start + minutes > 24 * 60) throw new Error('A pin has to fit inside its day.');
  // `live`: the block of a task someone started and has not stopped yet.
  return { day: pin.day, start, minutes, ...(pin.live ? { live: true } : {}) };
}

// ---------------------------------------------------------------- own events

export const eventsOf = (p) => (Array.isArray(p.events) ? p.events : []);

export const EVENT_COLOURS = {
  mint: { label: 'Mint', hex: '#3fb67a' }, sky: { label: 'Sky', hex: '#3d8bd9' }, lavender: { label: 'Lavender', hex: '#8c6ad9' },
  rose: { label: 'Rose', hex: '#d9557a' }, amber: { label: 'Amber', hex: '#d99a2b' }, slate: { label: 'Slate', hex: '#6b7a8c' },
};
export const EVENT_REPEATS = { none: 'Does not repeat', daily: 'Every day', weekdays: 'Every weekday (Mon–Fri)', weekly: 'Every week', monthly: 'Every month' };
export const TRAVEL_CHOICES = [0, 10, 15, 30, 45, 60, 90];

/**
 * An event made safe. It runs from `day` at `start` to `endDay` at `end`
 * (minutes into those days), or all of those days when `allDay`. `repeat`
 * copies it forward; `busy: false` shows it without taking the time;
 * `travel` is minutes held either side of it. `resourceId` says whose time
 * it takes — none means everyone on the plan, which for a plan of one's own
 * work is simply "me". Guests are names or addresses kept with it; nothing is
 * sent to them.
 */
export function cleanEvent(p, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim();
  if (!title) return null;
  if (!isoValid(raw.day)) return null;
  const endDay = isoValid(raw.endDay) && raw.endDay >= raw.day ? raw.endDay : raw.day;
  const allDay = raw.allDay === true;
  const start = allDay ? 0 : Math.round(+raw.start);
  const end = allDay ? 24 * 60 : Math.round(+raw.end);
  if (!(start >= 0 && start < 24 * 60 && end > 0 && end <= 24 * 60)) return null;
  if (endDay === raw.day && end <= start) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid('ev'),
    title, day: raw.day, start, endDay, end, allDay,
    repeat: EVENT_REPEATS[raw.repeat] ? raw.repeat : 'none',
    busy: raw.busy !== false,
    travel: TRAVEL_CHOICES.includes(+raw.travel) ? +raw.travel : 0,
    location: String(raw.location || '').trim(),
    link: String(raw.link || '').trim(),
    colour: EVENT_COLOURS[raw.colour] ? raw.colour : 'mint',
    guests: [...new Set((Array.isArray(raw.guests) ? raw.guests : String(raw.guests || '').split(/[,;\n]/)).map((g) => String(g).trim()).filter(Boolean))],
    notes: String(raw.notes || ''),
    resourceId: raw.resourceId && p.resources.some((r) => r.id === raw.resourceId) ? raw.resourceId : null,
  };
}

/**
 * The pieces of an event that fall between two day numbers, one per day it
 * touches: `{ day, start, end, first, last, occurrence }`. A repeating event
 * is copied forward from its first day; one running past midnight is cut at
 * each midnight.
 */
export function eventPieces(ev, from, to) {
  const first = toDay(ev.day);
  const span = toDay(ev.endDay || ev.day) - first;
  const starts = [];
  const push = (d) => { if (d + span >= from && d <= to) starts.push(d); };
  if (ev.repeat === 'none' || !ev.repeat) push(first);
  else if (ev.repeat === 'monthly') {
    const [y, m, dd] = ev.day.split('-').map(Number);
    for (let k = 0; k < 240; k++) {
      const date = new Date(Date.UTC(y, m - 1 + k, dd));
      if (date.getUTCDate() !== dd) continue;               // no 31 February
      const d = toDay(date.toISOString().slice(0, 10));
      if (d > to) break;
      push(d);
    }
  } else {
    const step = ev.repeat === 'weekly' ? 7 : 1;
    let d = first;
    if (d < from - span) d += Math.floor((from - span - d) / step) * step;
    for (; d <= to; d += step) {
      if (ev.repeat === 'weekdays') { const w = ((d % 7) + 11) % 7; if (w === 0 || w === 6) continue; }
      push(d);
    }
  }
  const out = [];
  for (const s of starts) {
    for (let k = 0; k <= span; k++) {
      const day = s + k;
      if (day < from || day > to) continue;
      out.push({ day, start: k === 0 ? ev.start : 0, end: k === span ? ev.end : 24 * 60, first: k === 0, last: k === span, occurrence: fromDay(s) });
    }
  }
  return out;
}

/** Add an event, or change one that is there already (same id). */
export function saveEvent(p, raw) {
  const ev = cleanEvent(p, raw);
  if (!ev) throw new Error('An event needs a title, a day, and an end after its start.');
  if (!Array.isArray(p.events)) p.events = [];
  const i = p.events.findIndex((x) => x.id === ev.id);
  if (i >= 0) p.events[i] = ev; else p.events.push(ev);
  return ev;
}
export function removeEvent(p, id) { p.events = eventsOf(p).filter((x) => x.id !== id); }

/** Which of a task's pins is the one running now, or -1. */
export const livePinIndex = (t) => pinsOf(t).findIndex((x) => x.live);

/**
 * Stop a task that was started: the time actually worked is logged — a
 * timesheet line with the hour it began, which the calendar draws as done —
 * the running block goes, and what the task still needs is what the person
 * says it needs. Nothing more needed means it is finished.
 */
export function stopWork(p, taskId, { worked, more }) {
  const t = getTask(p, taskId);
  if (!t) throw new Error('No such task.');
  const i = livePinIndex(t);
  if (i < 0) throw new Error('This task is not running.');
  const pin = pinsOf(t)[i];
  removePin(p, taskId, i);
  const w = Math.max(0, Math.round(+worked || 0));
  const m = Math.max(0, Math.round(+more || 0));
  if (w > 0) {
    addTimesheet(p, { taskId, resourceId: t.assignments[0]?.resourceId || null, date: pin.day, start: pin.start, hours: w / 60, note: 'Worked' });
  }
  logActivity(t, { kind: 'stopped', text: `worked ${hoursWords(w / 60)}${m > 0 ? `, ${hoursWords(m / 60)} more needed` : ', finished'}` });
  const spent = spentOn(p, taskId);
  if (m === 0) { setTaskField(p, taskId, 'percent', 100); return; }
  setTaskField(p, taskId, 'work', String(Math.round((spent + m / 60) * 100) / 100));
  // Floored, so "what is left by progress" is never less than what was said.
  setTaskField(p, taskId, 'percent', Math.min(99, Math.floor((spent / (spent + m / 60)) * 100)));
}

/** Pin a block, or move a pin that is already there when `index` names it. */
export function setPin(p, taskId, pin, index = null) {
  const t = getTask(p, taskId);
  if (!t) throw new Error('No such task.');
  const clean = checkPin(pin);
  const list = [...pinsOf(t)];
  if (index !== null && index >= 0 && index < list.length) list[index] = clean; else list.push(clean);
  list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.start - b.start));
  t.calendar = { ...(t.calendar || { show: true, timeBlockIds: [] }), pins: list };
  const clock = (m) => `${(Math.floor(m / 60) % 12) || 12}:${String(m % 60).padStart(2, '0')} ${m < 720 ? 'AM' : 'PM'}`;
  logActivity(t, { kind: clean.live ? 'started' : 'fixed', text: `${clean.day} ${clock(clean.start)}, ${hoursWords(clean.minutes / 60)}` });
  return clean;
}

export function removePin(p, taskId, index) {
  const t = getTask(p, taskId);
  if (!t) throw new Error('No such task.');
  const list = pinsOf(t).filter((_, i) => i !== index);
  t.calendar = { ...t.calendar, pins: list };
  logActivity(t, { kind: 'unfixed' });
}

export function clearPins(p, taskId) {
  const t = getTask(p, taskId);
  if (!t) throw new Error('No such task.');
  t.calendar = { ...t.calendar, pins: [] };
}

// ---------------------------------------------------------------- phases
//
// A phase is a top-level summary task — Discovery, Design, Build, Launch. When
// a plan says which phase it is in, the calendar releases only that phase's
// work: there is no point putting build tasks in next week's mornings while
// the design is still being argued about.

/** The top-level summary a task belongs to, or null for a task at the top. */
/**
 * The phases a plan runs through — design, build, launch.
 *
 * These are named by hand. They used to be read off the outline: every
 * top-level summary was a phase, which meant "Kick-off meeting with the
 * customer" and "Trade study of rotary" were offered as phases of a project
 * simply for being headings. An outline is how work is grouped; a phase is
 * where the project has got to. They are not the same question.
 */
export const phases = (p) => (Array.isArray(p.phases) ? p.phases : []);
export const getPhase = (p, id) => phases(p).find((ph) => ph.id === id) || null;

export function addPhase(p, props = {}) {
  if (!Array.isArray(p.phases)) p.phases = [];
  const phase = { id: uid('ph'), name: 'New phase', deadline: null, ...props };
  phase.name = String(phase.name).trim() || 'New phase';
  phase.deadline = isoValid(phase.deadline) ? phase.deadline : null;
  p.phases.push(phase);
  return phase;
}

export function setPhaseField(p, id, field, value) {
  const ph = getPhase(p, id);
  if (!ph) throw new Error('No such phase.');
  if (field === 'deadline') {
    if (value && !isoValid(value)) throw new Error('That is not a date.');
    ph.deadline = value || null;
    return;
  }
  if (field !== 'name') throw new Error(`“${field}” is not part of a phase.`);
  const name = String(value).trim();
  if (!name) throw new Error('A phase needs a name.');
  ph.name = name;
}

/** Remove a phase. Tasks in it go back to having none. */
export function removePhase(p, id) {
  p.phases = phases(p).filter((ph) => ph.id !== id);
  for (const t of p.tasks) if (t.phaseId === id) t.phaseId = null;
  if (p.currentPhaseId === id) p.currentPhaseId = null;
}

export function movePhase(p, id, dir) {
  const list = phases(p);
  const i = list.findIndex((ph) => ph.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return false;
  [list[i], list[j]] = [list[j], list[i]];
  return true;
}

/**
 * Custom fields — what a plan wants to record about its tasks that the plan
 * itself has no column for. The kinds are the ones people reach for: words,
 * a number, a link, a date, one or several of a list, one or several people.
 * A person is a resource of the plan, so a value points at someone who is
 * actually on it.
 */
export const FIELD_TYPES = {
  text: 'Text', number: 'Number', url: 'URL', date: 'Date',
  select: 'Select', multi: 'Multi select', person: 'Person', people: 'Multi person',
};
export const fieldsOf = (p) => (Array.isArray(p.fields) ? p.fields : []);
export const getField = (p, id) => fieldsOf(p).find((f) => f.id === id) || null;
const hasOptions = (type) => type === 'select' || type === 'multi';

/** A field definition made safe: a name, a known kind, and options when the kind has them. */
export function cleanField(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  if (!name) return null;
  const type = FIELD_TYPES[raw.type] ? raw.type : 'text';
  const options = hasOptions(type)
    ? [...new Set((Array.isArray(raw.options) ? raw.options : []).map((o) => String(o).trim()).filter(Boolean))]
    : [];
  return { id: typeof raw.id === 'string' && raw.id ? raw.id : uid('f'), name, type, options };
}

export function addField(p, props = {}) {
  const field = cleanField({ name: 'New field', ...props, id: undefined });
  if (!field) throw new Error('A field needs a name.');
  if (!Array.isArray(p.fields)) p.fields = [];
  p.fields.push(field);
  return field;
}

/** Remove a field, and every task's value for it. */
export function removeField(p, id) {
  p.fields = fieldsOf(p).filter((f) => f.id !== id);
  for (const t of p.tasks) if (t.fields && id in t.fields) delete t.fields[id];
}

/**
 * A value made to fit its field, or null for "nothing". A number that is not
 * one, an option the field does not offer, a person not on the plan — all
 * become nothing rather than a value that means something else.
 */
export function fieldValue(p, field, value) {
  if (value === null || value === undefined || value === '') return null;
  const people = new Set(p.resources.map((r) => r.id));
  switch (field.type) {
    case 'number': { const n = Number(value); return Number.isFinite(n) ? n : null; }
    case 'date': return isoValid(value) ? value : null;
    case 'url': { const u = String(value).trim(); return u ? (/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`) : null; }
    case 'select': return field.options.includes(String(value)) ? String(value) : null;
    case 'multi': { const v = (Array.isArray(value) ? value : [value]).map(String).filter((o) => field.options.includes(o)); return v.length ? [...new Set(v)] : null; }
    case 'person': return people.has(String(value)) ? String(value) : null;
    case 'people': { const v = (Array.isArray(value) ? value : [value]).map(String).filter((id) => people.has(id)); return v.length ? [...new Set(v)] : null; }
    default: { const v = String(value).trim(); return v || null; }
  }
}

export function setFieldValue(p, taskId, fieldId, value) {
  const t = getTask(p, taskId);
  const field = getField(p, fieldId);
  if (!t || !field) throw new Error('No such task or field.');
  const v = fieldValue(p, field, value);
  const old = t.fields?.[fieldId] ?? null;
  const fields = { ...(t.fields || {}) };
  if (v === null) delete fields[fieldId]; else fields[fieldId] = v;
  if (Object.keys(fields).length) t.fields = fields; else delete t.fields;
  const words = (x) => (x === null ? 'none' : formatFieldValue(p, field, x));
  if (words(old) !== words(v)) logActivity(t, { kind: 'change', field: field.name, from: words(old), to: words(v) });
}

/** A value as words: options and dates as they are, people by name. */
export function formatFieldValue(p, field, value) {
  if (value === null || value === undefined) return '';
  const who = (id) => p.resources.find((r) => r.id === id)?.name || '(gone)';
  if (field.type === 'person') return who(value);
  if (field.type === 'people') return value.map(who).join(', ');
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/**
 * The phase a task is in: its own, or the nearest ancestor's.
 *
 * Inheritance is what makes this bearable to fill in — put "Build" on the
 * heading and everything under it is build work, without a hundred edits.
 */
export function phaseOf(p, taskId) {
  const i = taskIndex(p, taskId);
  if (i < 0) return null;
  const own = p.tasks[i].phaseId;
  if (own && getPhase(p, own)) return own;
  for (const a of [...ancestors(p, i)].reverse()) {
    const id = p.tasks[a].phaseId;
    if (id && getPhase(p, id)) return id;
  }
  return null;
}

/**
 * Whether this task's phase is the one being worked on.
 *
 * No phase chosen: everything is released. A task with no phase at all is
 * released in every phase, because saying nothing cannot mean "not yet".
 */
export function inCurrentPhase(p, taskId) {
  if (!p.currentPhaseId) return true;
  if (!getPhase(p, p.currentPhaseId)) return true;
  const mine = phaseOf(p, taskId);
  return mine === null || mine === p.currentPhaseId;
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
/**
 * The hours a block covers, day by day.
 *
 * A block used to be one span on some days — "Work, 08:00–17:00, weekdays".
 * A schedule someone actually keeps is rarely that: 9 to 11:30 and 1 to 5 on
 * weekdays, the mornings only on Saturday. So a block may carry `slots`, one
 * { day, from, to } per range, and when it does they are the truth. A block
 * written before that still reads as its span on each of its days.
 *
 * @returns {Array<{day: number, from: string, to: string}>} sorted by day, then start
 */
export function slotsOf(block) {
  const toMin = (v) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim()); return m ? +m[1] * 60 + +m[2] : null; };
  const raw = Array.isArray(block?.slots) && block.slots.length
    ? block.slots
    : (block?.days || []).map((day) => ({ day, from: block.from, to: block.to }));
  return raw
    .filter((r) => r && Number.isInteger(+r.day) && +r.day >= 0 && +r.day <= 6 && toMin(r.from) !== null && toMin(r.to) !== null && toMin(r.to) > toMin(r.from))
    .map((r) => ({ day: +r.day, from: r.from, to: r.to }))
    .sort((a, b) => a.day - b.day || toMin(a.from) - toMin(b.from));
}

/**
 * Tidy a set of ranges: overlapping or touching ranges on the same day become
 * one, so a schedule drawn by dragging never double-counts an hour.
 */
export function mergeSlots(slots) {
  const toMin = (v) => { const [h, m] = String(v).split(':').map(Number); return h * 60 + m; };
  const fmt = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  const out = [];
  for (let day = 0; day <= 6; day++) {
    const ranges = slots.filter((r) => +r.day === day).map((r) => [toMin(r.from), toMin(r.to)])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const [a, b] of ranges) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    for (const [a, b] of merged) out.push({ day, from: fmt(a), to: fmt(b) });
  }
  return out;
}

export const timeBlocks = (p) => (Array.isArray(p.timeBlocks) && p.timeBlocks.length ? p.timeBlocks : DEFAULT_TIME_BLOCKS);
export const getTimeBlock = (p, id) => timeBlocks(p).find((b) => b.id === id) || null;

/**
 * The time blocks a task belongs to.
 *
 * A task may be in several — late evenings and the weekend, say — and is
 * placed in whichever has room first. `timeBlockId` is what one block used to
 * be called and is still read, so nothing written before this is lost.
 */
export const timeBlockIdsOf = (task) => {
  const c = task?.calendar || {};
  if (Array.isArray(c.timeBlockIds)) return c.timeBlockIds.filter(Boolean);
  return c.timeBlockId ? [c.timeBlockId] : [];
};

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
  for (const t of p.tasks) {
    const ids = timeBlockIdsOf(t);
    if (!ids.includes(id)) continue;
    t.calendar = { ...t.calendar, timeBlockIds: ids.filter((x) => x !== id), timeBlockId: undefined };
  }
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
  const start = props.start === undefined || props.start === null ? null : Math.round(+props.start);
  if (start !== null && !(start >= 0 && start < 24 * 60)) throw new Error('A timesheet line starts within its day.');
  const line = newTimesheet({ ...props, hours: Math.round(hours * 100) / 100 });
  if (start === null) delete line.start; else line.start = start;
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

/**
 * Record when a task was finished — local date and time, 'YYYY-MM-DDTHH:MM' —
 * or forget it when it goes back below 100%. It is what "completed today" is
 * read from; a task finished before this was kept simply has no time.
 */
export function stampDone(t, percent, at = localNow()) {
  if (percent === 100) { if (!t.doneAt) t.doneAt = at; }
  else delete t.doneAt;
}
const localNow = () => {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};
/** The day part of when a task was finished, or null. */
export const doneDay = (t) => (typeof t?.doneAt === 'string' ? t.doneAt.slice(0, 10) : null);

/** Put a task in a stage. A done stage completes it; that is what done means. */
export function setStage(p, taskId, stageId) {
  const t = getTask(p, taskId);
  const st = getStage(p, stageId);
  if (!t || !st) throw new Error('No such task or stage.');
  const was = getStage(p, t.stageId)?.name || null;
  t.stageId = st.id;
  if (st.done) { t.percent = 100; stampDone(t, 100); if (t.milestone) t.duration = 0; }
  if (was !== st.name) logActivity(t, { kind: 'change', field: 'status', from: was || 'none', to: st.name });
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
  if (st.done) for (const t of p.tasks) if (t.stageId === st.id) { t.percent = 100; stampDone(t, 100); }
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
// ---------------------------------------------------------------- activity
//
// Each task keeps what happened to it: made, renamed, moved, finished,
// time logged, and what people wrote about it. Newest last, the last 200.
// It lives in the task, so it travels with the plan and Undo takes an entry
// back with the change that made it.

const ACTIVITY_LIMIT = 200;
const stamp = () => {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};
export function logActivity(t, entry) {
  if (!t) return;
  const list = Array.isArray(t.activity) ? t.activity : [];
  list.push({ at: stamp(), ...entry });
  t.activity = list.slice(-ACTIVITY_LIMIT);
}
export function addComment(p, taskId, text) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('A comment needs some words.');
  logActivity(getTask(p, taskId), { kind: 'comment', text: clean.slice(0, 4000) });
}

const hoursWords = (h) => { const m = Math.round(h * 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`; };
/** A field as a person reads it, for the log; null for fields not worth a line. */
function describeField(p, t, field) {
  switch (field) {
    case 'name': return ['name', t.name];
    case 'work': return ['duration', t.work === null || t.work === undefined ? 'from the plan' : hoursWords(+t.work)];
    case 'duration': return ['days open', `${t.duration}d`];
    case 'percent': return ['progress', `${t.percent || 0}%`];
    case 'start': case 'constraintDate': case 'constraintType': return ['start date', t.constraint?.date || 'none'];
    case 'deadline': return ['deadline', t.deadline || 'none'];
    case 'hardDeadline': return ['hard deadline', t.hardDeadline ? 'on' : 'off'];
    case 'urgency': return ['priority', URGENCIES[t.urgency]?.label || 'Normal'];
    case 'notes': return ['description', null];
    case 'archived': return ['archived', t.archived ? 'yes' : 'no'];
    case 'labels': return ['labels', (t.labels || []).join(', ') || 'none'];
    case 'resources': return ['assignee', t.assignments.map((a) => p.resources.find((r) => r.id === a.resourceId)?.name).filter(Boolean).join(', ') || 'nobody'];
    case 'calendarShow': return ['on the calendar', t.calendar?.show ? 'yes' : 'no'];
    case 'blockHours': return ['min chunk', t.calendar?.blockHours ? hoursWords(t.calendar.blockHours) : 'the plan’s'];
    case 'wholeBlock': return ['min chunk', t.calendar?.whole ? 'no chunks' : 'chunks'];
    case 'timeBlock': return ['schedule', (t.calendar?.timeBlockIds || []).map((id) => getTimeBlock(p, id)?.name).filter(Boolean).join(', ') || 'any'];
    case 'milestone': return ['milestone', t.milestone ? 'yes' : 'no'];
    default: return null;
  }
}

export function setTaskField(p, id, field, value) {
  const t = getTask(p, id);
  if (!t) throw new Error('No such task.');
  const before = describeField(p, t, field);
  applyTaskField(p, t, id, field, value);
  const after = describeField(p, t, field);
  if (before && after && before[1] !== after[1]) {
    logActivity(t, before[1] === null ? { kind: 'change', field: before[0] } : { kind: 'change', field: before[0], from: before[1], to: after[1] });
  } else if (before && after && before[1] === null) {
    logActivity(t, { kind: 'change', field: before[0] });
  }
}

function applyTaskField(p, t, id, field, value) {
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
      stampDone(t, n);
      // Completing a task moves it to the finished column, and taking it back
      // off 100% moves it out of one — otherwise the board would lie.
      if (n === 100 && !wasDone) { const done = firstDoneStage(p); if (done) t.stageId = done.id; }
      if (n < 100 && wasDone) t.stageId = stages(p).find((st) => !st.done)?.id ?? null;
      break;
    }
    case 'predecessors': t.predecessors = parsePredecessors(p, value, id); break;
    case 'resources': t.assignments = parseAssignments(p, value); break;
    case 'notes': t.notes = String(value ?? ''); break;
    case 'archived': t.archived = !!value; break;
    // A hard deadline is one that must hold: it is placed ahead of soft ones.
    case 'hardDeadline': t.hardDeadline = !!value; if (!t.hardDeadline) delete t.hardDeadline; break;
    // Labels: short tags, kept as typed, each once.
    case 'labels': {
      const list = [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).map((x) => String(x).trim()).filter(Boolean))];
      if (list.length) t.labels = list; else delete t.labels;
      break;
    }
    // No chunks: laid as one block, however long.
    case 'wholeBlock': t.calendar = { ...t.calendar, whole: !!value }; if (!value) delete t.calendar.whole; break;
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
      // One id, or several: every one of them has to be a block this plan has.
      const wanted = Array.isArray(value) ? value.filter(Boolean) : (value ? [value] : []);
      for (const id of wanted) if (!getTimeBlock(p, id)) throw new Error('No such time block.');
      t.calendar = {
        ...t.calendar,
        timeBlockIds: [...new Set(wanted)],
        timeBlockId: undefined,
      };
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
