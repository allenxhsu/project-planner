// Routines: tasks that come round again — a weekly report, clearing the flags,
// the biweekly timesheet — set up once and never scheduled by hand again.
//
// A routine is a task with `repeat`: how often, on which days, from when. It
// is the pattern, not the work, so it is not on the calendar itself. Its
// occurrences are: real tasks, made a fortnight ahead, each starting on its
// day and due by the end of its period (the day before the next one; the
// same day for a daily or weekday routine), so the calendar lays each one
// inside its own week the way it lays anything else — and one that is not
// done shows late, like anything else.
//
// An occurrence's id is the routine's and the date (`t_ab12@2026-10-05`), so
// two devices making the same week's occurrence make the same task, and
// `repeat.made` says how far they have been made, so one that is deleted is
// not made again.

import { toDay, fromDay, weekday, weekStart } from './calendar.js';

export const REPEATS = {
  none: 'Does not repeat',
  daily: 'Every day',
  weekdays: 'Every weekday (Mon–Fri)',
  weekly: 'Every week',
  biweekly: 'Every 2 weeks',
  monthly: 'Every month',
};
/** How far ahead occurrences are made, in days. */
export const ROUTINE_HORIZON = 14;

const isoOk = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** A repeat as stored, or null for none: { freq, days?, from, made? }. */
export function cleanRepeat(raw) {
  if (!raw || typeof raw !== 'object' || !REPEATS[raw.freq] || raw.freq === 'none' || !isoOk(raw.from)) return null;
  const out = { freq: raw.freq, from: raw.from };
  if (raw.freq === 'weekly' || raw.freq === 'biweekly') {
    const days = [...new Set((Array.isArray(raw.days) ? raw.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    out.days = days.length ? days : [weekday(toDay(raw.from))];
  }
  // A set time ('HH:MM'): each occurrence is fixed there on its day, not placed by the calendar.
  if (typeof raw.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.at)) out.at = raw.at;
  if (isoOk(raw.made)) out.made = raw.made;
  return out;
}

export const repeatOf = (t) => cleanRepeat(t?.repeat);
export const isRoutine = (t) => !!repeatOf(t);

/** "Every 2 weeks on Mon, Thu" — how a routine says what it is. */
export function describeRepeat(repeat) {
  const r = cleanRepeat(repeat);
  if (!r) return REPEATS.none;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const at = r.at ? ` at ${clock(r.at)}` : '';
  if (r.days) return `${REPEATS[r.freq]} on ${r.days.map((d) => names[d]).join(', ')}${at}`;
  if (r.freq === 'monthly') return `Every month on the ${ordinal(+r.from.slice(8, 10))}${at}`;
  return `${REPEATS[r.freq]}${at}`;
}
const clock = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

/** Whether day `d` is one the routine falls on. */
function falls(r, d) {
  const from = toDay(r.from);
  if (d < from) return false;
  const wd = weekday(d);
  switch (r.freq) {
    case 'daily': return true;
    case 'weekdays': return wd >= 1 && wd <= 5;
    case 'weekly': return r.days.includes(wd);
    case 'biweekly': return r.days.includes(wd) && ((weekStart(d) - weekStart(from)) / 7) % 2 === 0;
    case 'monthly': {
      const iso = fromDay(d);
      const want = +r.from.slice(8, 10);
      const last = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7), 0)).getUTCDate();
      return +iso.slice(8, 10) === Math.min(want, last);
    }
    default: return false;
  }
}

/**
 * The occurrences from day `a` to day `b`: [{ day, due }]. `due` is the last
 * day of its period — the day before the next occurrence, or the day itself
 * for a daily or weekday routine, which is done the day it falls.
 */
export function occurrences(repeat, a, b) {
  const r = cleanRepeat(repeat);
  if (!r) return [];
  const out = [];
  for (let d = Math.max(a, toDay(r.from)); d <= b; d++) {
    if (!falls(r, d)) continue;
    let due = d;
    if (r.freq !== 'daily' && r.freq !== 'weekdays') {
      let n = d + 1;
      while (n < d + 62 && !falls(r, n)) n++;
      due = n - 1;
    }
    out.push({ day: d, due });
  }
  return out;
}

export const occurrenceId = (routineId, iso) => `${routineId}@${iso}`;

/**
 * Make what is due of every routine in the plan: each occurrence from the one
 * whose period is still running to a fortnight ahead, after the last one made.
 * `make(routine, { id, day, due })` adds the task (the model supplies it, so
 * this file stays free of the plan's internals). Returns how many were made.
 */
export function dueOccurrences(p, todayIso, { horizon = ROUTINE_HORIZON } = {}) {
  const today = toDay(todayIso);
  const out = [];
  for (const t of p.tasks) {
    const r = repeatOf(t);
    if (!r || t.archived) continue;
    const made = r.made ? toDay(r.made) : -Infinity;
    for (const o of occurrences(r, today - 62, today + horizon)) {
      if (o.day <= made || o.due < today) continue;
      // At a set time, a day already gone cannot be kept; without one, this period's is laid by its deadline.
      if (r.at && o.day < today) continue;
      const id = occurrenceId(t.id, fromDay(o.day));
      if (p.tasks.some((x) => x.id === id)) continue;
      out.push({ routine: t, id, day: fromDay(o.day), due: fromDay(o.due) });
    }
  }
  return out;
}
