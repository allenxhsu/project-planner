// Turning a plan into a week of work.
//
// The schedule says a task runs from Tuesday to Friday and takes 18 hours. A
// calendar has to say *when*: which hours on which days. That is what this
// does — it lays each task's remaining hours into blocks of the size the task
// asks for, inside the hours of the day it asks for, one after another, never
// double-booking the person doing them.
//
// Nothing here is stored. Blocks are computed from the plan, the same way the
// schedule is, so moving a task or logging four hours against it re-lays the
// week without anything to keep in step.

import { makeCalendar, toDay, fromDay, weekStart, weekday } from './calendar.js';
import { isSummary, timeBlocks, getTimeBlock, inCurrentPhase } from './model.js';

/** The block sizes a task can be cut into, in hours. */
export const BLOCK_CHOICES = [0.5, 1, 1.5, 2, 4];
/** A plan's defaults, which a task inherits until it says otherwise. */
export const DEFAULT_AGENDA = { blockHours: 1, from: '09:00', to: '17:00', timeBlockId: 'tb_work', gapMinutes: 0 };
/** Breathing room between one block and the next, in minutes. */
export const GAP_CHOICES = [0, 5, 10, 15, 30];

export const parseTime = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const min = +m[1] * 60 + +m[2];
  return min >= 0 && min <= 24 * 60 ? min : null;
};
export const formatTime = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export const formatClock = (min) => {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ampm}` : `${h12} ${ampm}`;
};

/**
 * A task's calendar settings: its block size, and the hours it is allowed.
 *
 * The hours come from the named time block it belongs to — "Deep focus,
 * 08:00–10:00, weekdays" — falling back to the plan's default block. A task
 * may still carry its own `from`/`to`, which wins; that is how a one-off gets
 * an hour nothing else uses without inventing a block for it.
 */
export function agendaOf(project, task) {
  const base = { ...DEFAULT_AGENDA, ...(project.agenda || {}) };
  const own = task.calendar || {};
  const blockHours = BLOCK_CHOICES.includes(own.blockHours) ? own.blockHours : base.blockHours;
  const named = getTimeBlock(project, own.timeBlockId) || getTimeBlock(project, base.timeBlockId) || timeBlocks(project)[0] || null;
  const from = parseTime(own.from) ?? parseTime(named?.from) ?? parseTime(base.from) ?? 540;
  const to = parseTime(own.to) ?? parseTime(named?.to) ?? parseTime(base.to) ?? 1020;
  return {
    show: !!own.show,
    blockHours,
    from,
    to,
    days: named?.days?.length ? [...named.days] : null,   // null: any working day
    timeBlock: named,
    gap: GAP_CHOICES.includes(+base.gapMinutes) ? +base.gapMinutes : 0,
  };
}

/** Hours this task still needs: what the plan expects, less what was logged. */
export function hoursLeft(project, info) {
  if (info.milestone) return 0;
  const hpd = project.calendar?.hoursPerDay || 8;
  // A task with nobody on it still takes time; the duration is the estimate.
  const expected = info.work > 0 ? info.work : info.duration * hpd;
  const left = expected - info.spent;
  // Progress is the other claim on how much is left; take the smaller.
  const byPercent = expected * (1 - (info.percent || 0) / 100);
  return Math.max(0, Math.min(left, byPercent));
}

/** Who a block belongs to, so two tasks for one person cannot overlap. */
const laneOf = (task) => task.assignments[0]?.resourceId || '__unassigned';

/** Free stretches of `[from, to)` on one day, given what is already booked. */
function freeSlots(booked, from, to) {
  const busy = [...booked].sort((a, b) => a.start - b.start);
  const out = [];
  let at = from;
  for (const b of busy) {
    if (b.start > at) out.push([at, Math.min(b.start, to)]);
    at = Math.max(at, b.end);
    if (at >= to) break;
  }
  if (at < to) out.push([at, to]);
  return out.filter(([a, b]) => b > a);
}

/**
 * Lay every task that asks to be on the calendar into blocks.
 *
 * Tasks are placed in schedule order, critical first, so the work that cannot
 * slip gets the earliest hours. A task whose blocks do not fit inside its own
 * dates keeps going into the days after — being told that a week does not hold
 * the work is the point, not an error to hide.
 *
 * @returns {{ blocks: Array, byTask: Map, overflow: Array }}
 */
export function planBlocks(project, schedule, { horizonDays = 180 } = {}) {
  const cal = makeCalendar(project.calendar);
  const blocks = [];
  const byTask = new Map();
  const overflow = [];
  /** laneKey → day → [{start, end}] */
  const booked = new Map();
  const bookedOn = (lane, day) => {
    if (!booked.has(lane)) booked.set(lane, new Map());
    const days = booked.get(lane);
    if (!days.has(day)) days.set(day, []);
    return days.get(day);
  };

  const candidates = project.tasks
    .map((t, i) => ({ t, i, info: schedule.tasks[t.id] }))
    // Only the phase the plan says it is in. Work from a phase that has not
    // started yet is real, but it is not this week's business.
    .filter(({ t, i, info }) => info && !info.cyclic && !isSummary(project, i) && agendaOf(project, t).show && inCurrentPhase(project, t.id))
    .sort((a, b) => (a.info.start - b.info.start) || (a.info.critical === b.info.critical ? a.info.slack - b.info.slack : a.info.critical ? -1 : 1));

  for (const { t, info } of candidates) {
    const a = agendaOf(project, t);
    const windowMinutes = Math.max(0, a.to - a.from);
    const size = Math.round(a.blockHours * 60);
    let left = Math.round(hoursLeft(project, info) * 60);
    const mine = [];
    if (left <= 0 || size <= 0 || windowMinutes < size) {
      if (left > 0) overflow.push({ taskId: t.id, minutes: left, reason: windowMinutes < size ? 'window-too-short' : 'none' });
      byTask.set(t.id, mine);
      continue;
    }
    const lane = laneOf(t);
    let day = cal.next(info.start);
    let guard = 0;
    while (left > 0 && guard++ < horizonDays) {
      // A time block says which days it covers; a day outside it is not this
      // task's to use, however free it looks.
      if (a.days && !a.days.includes(weekday(day))) { day = cal.next(day + 1); continue; }
      for (const [from, to] of freeSlots(bookedOn(lane, day), a.from, a.to)) {
        let at = from;
        while (left > 0 && at + size <= to) {
          const minutes = Math.min(size, left);
          const block = { taskId: t.id, day, start: at, end: at + minutes, minutes, lane, critical: info.critical, dateIso: fromDay(day) };
          blocks.push(block);
          mine.push(block);
          // The gap is booked with the block, so the next thing — this task's
          // or anyone's — starts after it rather than back to back.
          bookedOn(lane, day).push({ start: at, end: at + size + a.gap });
          at += size + a.gap;
          left -= minutes;
        }
        if (left <= 0) break;
      }
      day = cal.next(day + 1);
    }
    if (left > 0) overflow.push({ taskId: t.id, minutes: left, reason: 'horizon' });
    byTask.set(t.id, mine);
  }

  blocks.sort((x, y) => x.day - y.day || x.start - y.start);
  return { blocks, byTask, overflow };
}

/** The blocks that fall in one week, keyed by day number. */
export function weekOf(blocks, anyDayInWeek) {
  const start = weekStart(anyDayInWeek);
  const days = new Map();
  for (let d = start; d < start + 7; d++) days.set(d, []);
  for (const b of blocks) if (days.has(b.day)) days.get(b.day).push(b);
  return { start, days };
}

/**
 * What to do next, and why.
 *
 * The plan already knows everything needed to answer that: what is late, what
 * has no slack, what is waiting on something unfinished. This turns those into
 * one ordering, with the reason kept alongside the number so the list can say
 * why rather than only where.
 */
export function priorities(project, schedule, { now = null } = {}) {
  const todayDay = now ?? toDay(new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10));
  const status = project.statusDate ? toDay(project.statusDate) : todayDay;
  const done = new Set();
  for (const t of project.tasks) if ((schedule.tasks[t.id]?.percent ?? 0) === 100) done.add(t.id);

  const out = [];
  project.tasks.forEach((t, i) => {
    const info = schedule.tasks[t.id];
    if (!info || info.cyclic || isSummary(project, i) || info.percent === 100) return;
    const blockedBy = t.predecessors.filter((l) => !done.has(l.id) && schedule.tasks[l.id]).map((l) => l.id);
    const reasons = [];
    let score = 0;

    if (info.deadlineMissed) { score += 100; reasons.push('past its deadline'); }
    else if (t.deadline) {
      const days = toDay(t.deadline) - todayDay;
      if (days <= 14) { score += 60 - days * 2; reasons.push(days < 0 ? 'deadline passed' : `deadline in ${days} day${days === 1 ? '' : 's'}`); }
    }
    if (info.finish < status && info.percent < 100) { score += 50; reasons.push('should have finished by now'); }
    else if (info.start <= status) { score += 30; reasons.push('started, or due to start'); }
    if (info.critical) { score += 40; reasons.push('on the critical path'); }
    else score += Math.max(0, 20 - info.slack);
    if (info.percent > 0) { score += 10; reasons.push(`${info.percent}% done`); }
    // Something waiting on unfinished work cannot be started, however urgent.
    if (blockedBy.length) { score -= 45; reasons.push(`waiting on ${blockedBy.length} task${blockedBy.length === 1 ? '' : 's'}`); }
    // The nearer it starts, the more it matters now.
    score += Math.max(0, 25 - Math.abs(info.start - todayDay));

    out.push({
      taskId: t.id, index: info.index, name: t.name, score: Math.round(score), reasons,
      blocked: blockedBy.length > 0, blockedBy, info,
    });
  });
  return out.sort((a, b) => b.score - a.score || a.info.finish - b.info.finish);
}
