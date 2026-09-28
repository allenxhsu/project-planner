// The day's plan: what the calendar laid on one day, as data.
//
// "Today's tasks" was computed inside the Today screen's render, which meant
// it existed only while that page was open and only inside this app. Flow
// needs the same list — the same tasks in the same order — and the one thing
// it must not do is form a second opinion about it: a schedule is the output
// of the whole planner (estimates, dependencies, pins, people, calendars),
// and a reimplementation would disagree within a week.
//
// So the selection lives here, pure, and two callers share it: ui/today.js
// draws it, and state/sync.js publishes it as a record other apps read.

/**
 * The tasks the calendar has laid on `day`, oldest start first.
 *
 * `blocks` is the layout's flat list of laid work. A task can be laid in
 * several pieces across the day, so pieces are summed and the row is ordered
 * by the earliest of them — which is what makes the list read like the
 * calendar beside it.
 *
 * `percentOf(planId, taskId)` says how far along a task is; anything finished
 * belongs under "completed", not here. `hidden(planId)` drops a plan the
 * current place is not showing (at work, home projects are only "Busy").
 *
 * @returns {{ plan: string, task: string, start: number, minutes: number }[]}
 */
export function dayRows(blocks, day, { percentOf = () => 0, hidden = () => false } = {}) {
  const byTask = new Map();
  for (const b of blocks || []) {
    if (!b || b.day !== day || hidden(b.planId)) continue;
    const key = `${b.planId}|${b.taskId}`;
    const row = byTask.get(key) || { plan: b.planId, task: b.taskId, start: b.start, minutes: 0 };
    row.minutes += b.minutes;
    row.start = Math.min(row.start, b.start);
    byTask.set(key, row);
  }
  return [...byTask.values()]
    .filter((r) => (percentOf(r.plan, r.task) ?? 0) < 100)
    // Earliest first, then by plan and task so two tasks at the same minute
    // never swap places between one render and the next.
    .sort((a, b) => a.start - b.start || a.plan.localeCompare(b.plan) || a.task.localeCompare(b.task));
}

/** The record type other apps read the day from. */
export const AGENDA_TYPE = 'agenda';

/** One day's plan as a sync record. `person` is whose day it is, for an app that shows one. */
export function agendaRecord({ day, rows, person = '', at = Date.now(), origin = '' }) {
  return {
    id: `agenda_${day}`, type: AGENDA_TYPE, day, person: String(person || ''),
    tasks: (rows || []).map((r) => ({ plan: r.plan, task: r.task, start: r.start, minutes: r.minutes })),
    updatedAt: at, deletedAt: null, origin,
  };
}

/**
 * Whether a day's plan says anything new.
 *
 * The layout is recomputed on every edit, so a writer that saved
 * unconditionally would push a record several times a minute and wake every
 * other device each time. Only the day's content counts — not when it was
 * computed, and not who by.
 */
export function sameDay(a, b) {
  if (!a || !b) return false;
  const key = (r) => `${r.plan}|${r.task}|${r.start}|${r.minutes}`;
  const x = (a.tasks || []).map(key);
  const y = (b.tasks || []).map(key);
  return a.day === b.day && a.person === b.person && x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Six months, in days: how long ago a deadline has to be to count as housekeeping. */
export const STALE_DONE_DAYS = 183;

/**
 * Whether ticking this off today was catching up rather than doing the work.
 *
 * Marking a year of finished work complete in one sitting is ordinary
 * housekeeping, and it should not read as a day in which nineteen things were
 * achieved: the point of "completed today" is to show the day, and a list
 * dominated by deadlines from last March shows nothing. A task whose deadline
 * passed more than six months before the day it was ticked is filed as
 * catching up; one with no deadline, or a recent one, is real work done.
 *
 * `day` and `deadlineDay` are day numbers, as `model/calendar.js` counts them.
 */
export function caughtUp(deadlineDay, day, { staleAfter = STALE_DONE_DAYS } = {}) {
  if (!Number.isFinite(deadlineDay) || !Number.isFinite(day)) return false;
  return day - deadlineDay > staleAfter;
}
