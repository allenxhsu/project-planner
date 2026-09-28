// Operations from the Flow app.
//
// Flow never rewrites a plan. It writes write-once records into this app's
// `project` workspace — `{ id, type: 'flow.op', op, plan, at, origin, … }` —
// and the plan takes them itself, through the same editing functions a person
// uses, so an applied operation is an ordinary edit of the plan: it undoes,
// autosaves and syncs like any other, and never replaces unsaved work.
//
//   addTask    task: { id, name, work (hours) | null, deadline | null }
//              appended at the end of the plan, outline level 1, with exactly
//              Flow's id, on the player's resource (`me`) when the plan has one
//   timesheet  task, date, start (minutes into the day), hours, note
//              a timesheet line on that task, resource as above
//
// Each is applied once per plan. The plan remembers what it applied in
// `appliedOps: [{ id, at }]`, which travels with it, so a re-sync or a second
// device never applies one twice. Ids are kept for 90 days; an operation
// written longer ago than that is no longer pending, so pruning its id can
// never bring it back. Pure: no I/O, and `now` is given.

import { insertTask, getTask, assign, addTimesheet } from './model.js';
import { isoValid } from './calendar.js';
import { serialize, parse } from '../io/json.js';

export const OP_TYPE = 'flow.op';
export const KEEP_APPLIED_MS = 90 * 86_400_000;

/** The operation types this Planner applies. Any other is left pending for a Planner that knows it. */
const HANDLERS = { addTask, timesheet };

/** Flow's rule for "the player's Planner name": case- and space-insensitive. */
const nameKey = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '');

/** When an operation was written, in ms; null when it does not say. */
function writtenAt(op) {
  const at = typeof op.at === 'number' ? op.at : Date.parse(op.at);
  if (Number.isFinite(at)) return at;
  return Number.isFinite(+op.updatedAt) ? +op.updatedAt : null;
}

const appliedIds = (project) => new Set((Array.isArray(project.appliedOps) ? project.appliedOps : []).map((a) => a.id));

/**
 * The operations waiting for this plan, oldest first: Flow's, for this plan,
 * of a type this Planner applies, not applied yet, and written within the
 * last 90 days.
 */
export function pendingOps(records, project, { now = Date.now() } = {}) {
  const done = appliedIds(project);
  return (records || [])
    .filter((r) => r && r.type === OP_TYPE && !r.deletedAt && typeof r.id === 'string' && r.plan === project.id
      && Object.hasOwn(HANDLERS, r.op) && !done.has(r.id)
      && !((writtenAt(r) ?? now) < now - KEEP_APPLIED_MS))
    .sort((a, b) => (writtenAt(a) ?? 0) - (writtenAt(b) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The player's work resource in this plan, or null. Never adds one. */
function playerResource(project, me) {
  const key = nameKey(me);
  if (!key) return null;
  return project.resources.find((r) => r.type !== 'material' && r.type !== 'cost' && nameKey(r.name) === key) || null;
}

function addTask(project, op) {
  const t = op.task;
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id) return;   // malformed: nothing to add
  if (getTask(project, t.id)) return;                                            // already here
  const work = t.work !== null && t.work !== undefined && Number.isFinite(+t.work) && +t.work >= 0 ? +t.work : null;
  const perDay = Number(project.calendar?.hoursPerDay) > 0 ? Number(project.calendar.hoursPerDay) : 8;
  const task = insertTask(project, project.tasks.length, {
    id: t.id, name: String(t.name ?? '').trim() || 'New task', level: 1,
    work, deadline: isoValid(t.deadline) ? t.deadline : null,
    // Open long enough to hold its hours at a full day each.
    duration: work ? Math.max(1, Math.ceil(work / perDay)) : 1,
  });
  const who = playerResource(project, op.me);
  if (who) assign(project, task.id, who.id, 1);
}

function timesheet(project, op) {
  if (!getTask(project, op.task)) return;                                        // the task is gone
  const who = playerResource(project, op.me);
  const start = Number.isInteger(op.start) && op.start >= 0 && op.start < 24 * 60 ? op.start : null;
  try {
    addTimesheet(project, {
      taskId: op.task, resourceId: who ? who.id : null,
      date: isoValid(op.date) ? op.date : null, start,
      hours: op.hours, note: typeof op.note === 'string' ? op.note : 'Flow timer',
    });
  } catch { /* hours that are not hours: nothing to log, and nothing to retry */ }
}

/**
 * Apply operations to a plan, in place (so it can run inside a commit).
 * Operations for another plan, already applied, or of an unknown type are
 * left alone. One that cannot apply — its task is gone, it is malformed — is
 * skipped and still remembered as applied, because it never will.
 *
 * @returns {{ project, applied: { id, at }[] }}
 */
export function applyOps(project, ops, { now = Date.now() } = {}) {
  const done = appliedIds(project);
  const applied = [];
  for (const op of ops || []) {
    if (!op || op.type !== OP_TYPE || op.plan !== project.id || !Object.hasOwn(HANDLERS, op.op)) continue;
    if (typeof op.id !== 'string' || done.has(op.id)) continue;
    HANDLERS[op.op](project, op);
    done.add(op.id);
    applied.push({ id: op.id, at: now });
  }
  if (applied.length) {
    const kept = (Array.isArray(project.appliedOps) ? project.appliedOps : []).filter((a) => a.at >= now - KEEP_APPLIED_MS);
    project.appliedOps = [...kept, ...applied];
  }
  return { project, applied };
}

/**
 * A plan on the shelf: its record with the operations applied, written newer
 * than the one it replaces, or null when there is nothing to apply (or the
 * record cannot be read).
 */
export function applyToRecord(record, ops, { now = Date.now(), origin } = {}) {
  if (!record || record.deletedAt || typeof record.body !== 'string') return null;
  let project;
  try { project = parse(record.body).project; } catch { return null; }
  const { applied } = applyOps(project, ops, { now });
  if (!applied.length) return null;
  return { ...record, body: serialize(project), updatedAt: Math.max(now, (+record.updatedAt || 0) + 1), origin: origin ?? record.origin };
}
