// The daily focus: how many tasks a day holds, and which.
//
// A calendar that lays every released task into every free hour is a wall:
// with a hundred and forty plans on the shelf, a day held whatever fitted,
// which was too much to look at and too much to do. A day now holds at most
// six tasks, in three buckets, in this order:
//
//   1. essential priority   — one task: the one thing the day is for;
//   2. essential and urgent — two;
//   3. maintenance          — three: routines, low-urgency work, and whatever
//                             else there was room for.
//
// Everything else waits for the next working day with a free slot. Nothing is
// dropped, and nothing is a new field on a task: a task is promoted by
// changing its urgency, and a routine's occurrence is maintenance because it
// is a routine. The counts are a setting of the plan (`agenda.focus`).
//
// Two things live here, both pure. `dayFocus` labels a day's tasks by rank.
// `makeFocus` is the roster the calendar's placement asks before it lays a
// task's first block on a day — in the order it lays work, which is the
// order the hours are given out — and that remembers who was refused a day
// and where they went, so the calendar can say so.

import { isRoutine } from './routines.js';
import { urgencyOf, URGENCIES } from './model.js';

/** The buckets, in the order a day reads them. */
export const DEFAULT_FOCUS = { priority: 1, urgent: 2, maintenance: 3 };
/** What each count may be. All three at zero switches the limit off. */
export const FOCUS_CHOICES = [0, 1, 2, 3, 4, 5, 6];
export const FOCUS_LABELS = { priority: 'Essential priority', urgent: 'Essential and urgent', maintenance: 'Maintenance' };

/** Counts as stored, each falling back to its default when it is not a choice. */
export function cleanFocus(raw) {
  const out = { ...DEFAULT_FOCUS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(DEFAULT_FOCUS)) {
    const n = raw[k] === '' || raw[k] === null ? NaN : +raw[k];
    if (FOCUS_CHOICES.includes(n)) out[k] = n;
  }
  return out;
}
/** A plan's counts. */
export const focusOf = (project) => cleanFocus(project?.agenda?.focus);
export const focusOff = (counts) => counts.priority + counts.urgent + counts.maintenance === 0;

/** Upkeep rather than progress: a routine (the pattern or one of its occurrences), or work marked low. */
export const isMaintenanceWork = (task) => !!task?.repeatOf || isRoutine(task) || urgencyOf(task) === 'low';

/**
 * Essential rank: "now" first, then "high", then the earliest deadline, then
 * the critical path, then the order the scheduler laid the work in.
 * Candidates are `{ urgency, deadline (day number or Infinity), critical, order }`.
 */
export function rankEssential(a, b) {
  return (URGENCIES[a.urgency]?.rank ?? 2) - (URGENCIES[b.urgency]?.rank ?? 2)
    || (a.deadline - b.deadline || 0)
    || ((a.critical ? 0 : 1) - (b.critical ? 0 : 1))
    || (a.order - b.order);
}
/** Maintenance rank: routines first, then low urgency, then whatever remains in essential rank. */
export function rankMaintenance(a, b) {
  return ((a.routine ? 0 : 1) - (b.routine ? 0 : 1))
    || ((a.urgency === 'low' ? 0 : 1) - (b.urgency === 'low' ? 0 : 1))
    || rankEssential(a, b);
}
const maintenanceClass = (c) => c.routine || c.urgency === 'low';

/**
 * A day's tasks in their buckets. The essentials are ranked and the first
 * fill priority, then urgent; what is left of them joins the maintenance
 * work, routines first. The caller has already kept the day to its counts,
 * so this only says which is which.
 */
export function dayFocus(onDay, counts) {
  const essentials = onDay.filter((c) => !maintenanceClass(c)).sort(rankEssential);
  const priority = essentials.slice(0, counts.priority);
  const urgent = essentials.slice(counts.priority, counts.priority + counts.urgent);
  const maintenance = [...onDay.filter(maintenanceClass), ...essentials.slice(counts.priority + counts.urgent)].sort(rankMaintenance);
  return { priority, urgent, maintenance };
}

/**
 * The roster: which tasks each day admits.
 *
 * `admit(day, candidate)` says whether the task may have hours on that day,
 * and records it when it may. Asked again for the same task and day it says
 * yes and counts nothing: a task is one of the six however many blocks it
 * is cut into. Maintenance work takes only the maintenance slots; essential
 * work takes the essential slots first and then whatever maintenance left
 * free, which is the "whatever remains" of the third bucket. `force` is for
 * a block fixed by hand or already under way: it is where it is.
 *
 * `on(day)` reads the day back: its buckets, and `heldBack` — every task
 * refused that day, with `to`, the day it was admitted instead (null while
 * it has not been).
 */
export function makeFocus(counts = DEFAULT_FOCUS) {
  counts = cleanFocus(counts);
  const off = focusOff(counts);
  const total = counts.priority + counts.urgent + counts.maintenance;
  /** day → Map(key → candidate) */
  const days = new Map();
  /** day → [{ ...candidate, to }] */
  const refused = new Map();
  /** key → the refusals still waiting to learn where the task went */
  const pending = new Map();
  const keyOf = (c) => `${c.planId}|${c.taskId}`;
  const admit = (day, c, { force = false } = {}) => {
    if (!days.has(day)) days.set(day, new Map());
    const onDay = days.get(day);
    const key = keyOf(c);
    if (onDay.has(key)) return true;
    if (!off && !force) {
      const have = [...onDay.values()];
      const upkeep = have.filter(maintenanceClass).length;
      // Upkeep keeps to its own slots; essential work may also take what upkeep left free.
      const room = maintenanceClass(c) ? upkeep < counts.maintenance : have.length < total;
      if (!room) {
        if (!refused.has(day)) refused.set(day, []);
        const entry = { ...c, day, to: null };
        refused.get(day).push(entry);
        if (!pending.has(key)) pending.set(key, []);
        pending.get(key).push(entry);
        return false;
      }
    }
    onDay.set(key, c);
    for (const entry of pending.get(key) || []) if (entry.day < day) entry.to = day;
    pending.delete(key);
    return true;
  };
  const on = (day) => ({ ...dayFocus([...(days.get(day)?.values() || [])], counts), heldBack: [...(refused.get(day) || [])] });
  return { counts, off, admit, on, days: () => [...days.keys()].sort((a, b) => a - b) };
}
