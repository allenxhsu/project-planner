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
import { isSummary, timeBlocks, getTimeBlock, timeBlockIdsOf, inCurrentPhase, feeds, bufferOf, getResource, identityOf, pinsOf, URGENCIES, urgencyOf } from './model.js';

/** The block sizes a task can be cut into, in hours. */
export const BLOCK_CHOICES = [0.5, 1, 1.5, 2, 4];
/** A plan's defaults, which a task inherits until it says otherwise. */
export const DEFAULT_AGENDA = { blockHours: 1, from: '09:00', to: '17:00', timeBlockId: 'tb_work', gapMinutes: 0, assumedLoad: 50, dailyCap: 6 };
/** Breathing room between one block and the next, in minutes. */
export const GAP_CHOICES = [0, 5, 10, 15, 30];
/**
 * How much of a day a task uses when it does not say how many hours it takes.
 *
 * Duration is how long a task is open; work is how much of that time goes into
 * it. They are not the same thing, and assuming they were is what filled every
 * hour of every day: a five-day design task claimed forty hours and left no
 * room for anything else. Unless a task states its work, the calendar now
 * assumes it uses this share of each day.
 */
export const LOAD_CHOICES = [25, 50, 75, 100];
/** The most planned work the calendar will put in one person's day, in hours. */
export const CAP_CHOICES = [2, 4, 6, 8, 12];

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
  // A task can belong to several blocks — late evenings *and* the weekend —
  // and is placed in whichever of them has room first. One block is the
  // ordinary case and is just a list of one.
  const chosen = timeBlockIdsOf(task).map((id) => getTimeBlock(project, id)).filter(Boolean);
  const named = chosen[0] || getTimeBlock(project, base.timeBlockId) || timeBlocks(project)[0] || null;
  const list = chosen.length ? chosen : (named ? [named] : []);
  // A task's own hours, when it states them, override every block it is in:
  // that is how a one-off gets an hour nothing else uses.
  const ownFrom = parseTime(own.from);
  const ownTo = parseTime(own.to);
  const windows = ownFrom !== null && ownTo !== null
    ? [{ from: ownFrom, to: ownTo, days: null, block: named }]
    : list.map((b) => ({
      from: parseTime(b.from) ?? parseTime(base.from) ?? 540,
      to: parseTime(b.to) ?? parseTime(base.to) ?? 1020,
      days: b.days?.length ? [...b.days] : null,
      block: b,
    })).filter((w) => w.to > w.from).sort((a, b) => a.from - b.from);
  const safe = windows.length ? windows : [{ from: parseTime(base.from) ?? 540, to: parseTime(base.to) ?? 1020, days: null, block: named }];
  const from = Math.min(...safe.map((w) => w.from));
  const to = Math.max(...safe.map((w) => w.to));
  return {
    show: !!own.show,
    blockHours,
    windows: safe,
    // The outer bounds of every window, for anything that needs one span.
    from,
    to,
    days: safe.every((w) => w.days) ? [...new Set(safe.flatMap((w) => w.days))].sort() : null,
    timeBlock: named,
    timeBlocks: list,
    gap: GAP_CHOICES.includes(+base.gapMinutes) ? +base.gapMinutes : 0,
    assumedLoad: LOAD_CHOICES.includes(+base.assumedLoad) ? +base.assumedLoad : DEFAULT_AGENDA.assumedLoad,
    dailyCap: CAP_CHOICES.includes(+base.dailyCap) ? +base.dailyCap : DEFAULT_AGENDA.dailyCap,
  };
}

/**
 * Hours this task still needs: what the plan expects, less what was logged.
 *
 * What the plan expects is the task's own work when it states it. When it does
 * not, the work the scheduler implies is duration at full time, which is the
 * wrong thing to put on a calendar — a five-day task is rarely five days of
 * doing it. An implied figure is taken at the plan's assumed load instead,
 * and a stated one is used exactly as stated.
 */
export function hoursLeft(project, info, task = null) {
  if (info.milestone) return 0;
  const hpd = project.calendar?.hoursPerDay || 8;
  const load = (task ? agendaOf(project, task).assumedLoad : (LOAD_CHOICES.includes(+project.agenda?.assumedLoad) ? +project.agenda.assumedLoad : DEFAULT_AGENDA.assumedLoad)) / 100;
  const stated = task && Number.isFinite(+task.work) && task.work !== null && task.work !== undefined && +task.work >= 0;
  // A task with nobody on it still takes time; the duration is the estimate.
  const full = info.work > 0 ? info.work : info.duration * hpd;
  const expected = stated ? +task.work : full * load;
  const left = expected - info.spent;
  // Progress is the other claim on how much is left; take the smaller.
  const byPercent = expected * (1 - (info.percent || 0) / 100);
  return Math.max(0, Math.min(left, byPercent));
}

/**
 * Whose time a task takes — every person on it, not just the first.
 *
 * Booking only the first assignee was a real bug: a task for Priya and Uma
 * took Priya's hour and left Uma apparently free, so the next task of Uma's
 * could be placed on top of it and she would be in two places at once.
 */
const lanesOf = (task) => {
  const ids = task.assignments.map((a) => a.resourceId).filter(Boolean);
  return ids.length ? [...new Set(ids)] : ['__unassigned'];
};

/**
 * Who someone *is*, across plans.
 *
 * One calendar covers every plan on the shelf, and a person is in several of
 * them — but each plan keeps its own resource list, so Uma Chen is a different
 * id in each. The name is what carries across, which is why booking is keyed
 * on it: two plans asking for Uma's Tuesday morning are one clash, not two
 * bookings that never meet.
 */
export const personKey = (name) => `who:${String(name || '').trim().toLowerCase()}`;
/** A plan's resource, as the person it stands for: the shared id, or the name. */
export const personKeyOf = (resource) => identityOf(resource);
const peopleOf = (project, task) => {
  const keys = task.assignments
    .map((a) => getResource(project, a.resourceId))
    .filter(Boolean)
    .map(personKeyOf);
  return keys.length ? [...new Set(keys)] : ['__unassigned'];
};

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
/** One plan's blocks — the whole shelf's calendar, narrowed to this plan. */
export function planBlocks(project, schedule, opts = {}) {
  return planBlocksAcross([{ project, schedule }], opts);
}

/**
 * Every plan's blocks, on one calendar.
 *
 * The hours of a week are shared by everything a person is working on, so the
 * placement has to be too: plans are laid out together, in schedule order,
 * against one booking sheet. Otherwise two plans would each think Tuesday
 * morning was free and both take it.
 *
 * @param {Array<{project: object, schedule: object}>} entries
 */
export function planBlocksAcross(entries, { horizonDays = 180 } = {}) {
  // One plan, once. The same plan arriving twice — the open copy and its own
  // record from the shelf — would book every hour of it twice over.
  const seenPlans = new Set();
  entries = entries.filter(({ project }) => {
    const key = project?.id;
    if (!key) return true;
    if (seenPlans.has(key)) return false;
    seenPlans.add(key);
    return true;
  });
  const first = entries[0]?.project;
  const cal = makeCalendar(first?.calendar);
  const blocks = [];
  const byTask = new Map();
  const overflow = [];
  /** laneKey → day → [{start, end}] */
  const booked = new Map();
  /** laneKey → day → minutes of planned work already placed there. */
  const filled = new Map();
  const filledOn = (lane, day) => filled.get(lane)?.get(day) || 0;
  const fill = (lane, day, minutes) => {
    if (!filled.has(lane)) filled.set(lane, new Map());
    const days = filled.get(lane);
    days.set(day, (days.get(day) || 0) + minutes);
  };
  const todayDay = toDay(new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10));
  const floorOf = (project) => (project.statusDate ? toDay(project.statusDate) : todayDay);

  /**
   * A connected calendar's meetings are booked before any task is placed, so
   * work goes around them. A feed that names a resource books that person's
   * hours; one that names nobody books the unassigned lane.
   *
   * An event that is somewhere — it has a location — also books travel time
   * either side of it, the feed's buffer, so the calendar does not lay work up
   * to the minute someone has to be across town. All-day events have none.
   */
  const meetings = [];
  const seenMeetings = new Set();
  for (const { project } of entries) for (const feed of feeds(project)) {
    const owner = feed.resourceId ? getResource(project, feed.resourceId) : null;
    const lane = owner ? personKeyOf(owner) : '__unassigned';
    const buffer = bufferOf(feed);
    for (const e of feed.events || []) {
      const d = new Date(e.start);
      const day = toDay(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      const startMin = e.allDay ? 0 : d.getHours() * 60 + d.getMinutes();
      const length = Math.max(15, Math.round((e.end - e.start) / 60000));
      const endMin = e.allDay ? 24 * 60 : Math.min(24 * 60, startMin + length);
      // The same calendar connected to two plans is still one meeting.
      const seal = `${lane}|${day}|${startMin}|${e.uid || e.title}`;
      if (seenMeetings.has(seal)) continue;
      seenMeetings.add(seal);
      const travels = !e.allDay && buffer > 0 && typeof e.location === 'string' && e.location.trim() !== '';
      meetings.push({
        lane, day, start: startMin, end: endMin, title: e.title, allDay: !!e.allDay,
        location: e.location || null, description: e.description || null,
        uid: e.uid || null, feedId: feed.id, feedName: feed.name, planId: project.id, buffer,
        bufferBefore: travels ? Math.min(buffer, startMin) : 0,
        bufferAfter: travels ? Math.min(buffer, 24 * 60 - endMin) : 0,
      });
    }
  }
  const bookedOn = (lane, day) => {
    if (!booked.has(lane)) booked.set(lane, new Map());
    const days = booked.get(lane);
    if (!days.has(day)) {
      // Seed the day with whatever the connected calendars already hold,
      // travel time included.
      days.set(day, meetings.filter((m) => m.lane === lane && m.day === day)
        .map((m) => ({ start: m.start - m.bufferBefore, end: m.end + m.bufferAfter })));
    }
    return days.get(day);
  };

  const candidates = entries
    .flatMap(({ project, schedule }) => project.tasks
      .map((t, i) => ({ t, i, info: schedule.tasks[t.id], project }))
      // Only the phase each plan says it is in. Work from a phase that has not
      // started yet is real, but it is not this week's business.
      .filter(({ t, i, info, project: pr }) => info && !info.cyclic && !t.archived && !isSummary(pr, i) && agendaOf(pr, t).show && inCurrentPhase(pr, t.id)))
    .map((c) => ({ ...c, deadline: c.t.deadline ? toDay(c.t.deadline) : Infinity }))
    // Earliest deadline first. For work that can be cut up and done in any
    // order — which is what blocks make of it — on one person's time, that
    // order meets every deadline any order could have met. Urgency breaks ties
    // between equal deadlines, and a task with no deadline sorts after the
    // dated ones, so a plan that sets none lays out exactly as it did.
    //
    // One exception, on purpose: "do it now" still goes first. It is a person
    // saying, in so many words, that this beats the arithmetic.
    .sort((a, b) =>
      ((urgencyOf(a.t) === 'now' ? 0 : 1) - (urgencyOf(b.t) === 'now' ? 0 : 1))
      || (a.deadline - b.deadline || 0)
      || (URGENCIES[urgencyOf(a.t)].rank - URGENCIES[urgencyOf(b.t)].rank)
      || (a.info.start - b.info.start)
      || (a.info.critical === b.info.critical ? a.info.slack - b.info.slack : a.info.critical ? -1 : 1));

  // ---- pins first: a block someone put somewhere by hand is where it is.
  const pinnedMinutes = new Map();
  const droppedPins = [];
  for (const { t, info, project } of candidates) {
    const pins = pinsOf(t);
    if (!pins.length) continue;
    const a = agendaOf(project, t);
    const people = peopleOf(project, t);
    const lanes = lanesOf(t);
    const floor = floorOf(project);
    let left = Math.round(hoursLeft(project, info, t) * 60);
    let used = 0;
    pins.forEach((pin, index) => {
      const day = toDay(pin.day);
      // A pin that can no longer happen is dropped, not drawn as a ghost:
      // its day has gone, its task is done, or it asks for time the task no
      // longer needs.
      const reason = day < floor ? 'past' : left <= 0 ? 'done' : null;
      if (reason) { droppedPins.push({ taskId: t.id, planId: project.id, index, reason, pin }); return; }
      const minutes = Math.min(pin.minutes, left);
      const block = {
        taskId: t.id, planId: project.id, planName: project.name,
        day, start: pin.start, end: pin.start + minutes, minutes,
        lanes, lane: lanes[0], people, critical: info.critical, dateIso: fromDay(day),
        overdue: info.start < floor, pinned: true, pinIndex: index,
      };
      blocks.push(block);
      if (!byTask.has(t.id)) byTask.set(t.id, []);
      byTask.get(t.id).push(block);
      for (const lane of people) { bookedOn(lane, day).push({ start: pin.start, end: pin.start + minutes + a.gap }); fill(lane, day, minutes); }
      left -= minutes;
      used += minutes;
    });
    pinnedMinutes.set(t.id, used);
  }

  // ---- then everything else, around them.
  for (const { t, info, project, deadline } of candidates) {
    const a = agendaOf(project, t);
    // The longest window is what decides whether a block can fit at all.
    const windowMinutes = Math.max(0, ...a.windows.map((w) => w.to - w.from));
    const size = Math.round(a.blockHours * 60);
    let left = Math.round(hoursLeft(project, info, t) * 60) - (pinnedMinutes.get(t.id) || 0);
    const mine = byTask.get(t.id) || [];
    if (left <= 0 || size <= 0 || windowMinutes < size) {
      if (left > 0) overflow.push({ taskId: t.id, planId: project.id, minutes: left, reason: windowMinutes < size ? 'window-too-short' : 'none' });
      byTask.set(t.id, mine);
      continue;
    }
    const lanes = lanesOf(t);
    const people = peopleOf(project, t);
    // A calendar is about the days still ahead. Work the schedule says should
    // have started already, and is not finished, is overdue — and overdue
    // work is done from today on, not written into a May that has gone, where
    // nobody will ever see it. The floor is the plan's status date when it
    // has one, which is Microsoft Project's "as of" and what a plan being
    // looked at from another day means; otherwise it is today.
    //
    // "Do it now" means today, not the day the schedule would have started it.
    const urgency = urgencyOf(t);
    const floor = floorOf(project);
    const firstDay = cal.next(urgency === 'now' ? floor : Math.max(info.start, floor));
    const overdue = info.start < floor;
    // Duration is how long the task is open; work is how much of that time is
    // spent on it. A five-day design task of twelve hours is three hours a day,
    // not three full days and two idle ones — so each day takes its share,
    // rounded up to a whole block. The days are the ones before the deadline
    // when there is one: spreading work past the day it is due is how a plan
    // with room to spare still misses.
    //
    // The share is worked out again every day, against the days that are
    // left. Fixed once at the start, a day lost to something else — Monday
    // taken by an earlier deadline — shrinks the room for this task without
    // raising its share of what is left, and a deadline the week could have
    // met is missed. Once the deadline has passed, every day is the last one.
    const lastDay = Number.isFinite(deadline) ? Math.min(info.finish, deadline) : info.finish;
    let day = firstDay;
    let guard = 0;
    while (left > 0 && guard++ < horizonDays) {
      // A time block says which days it covers; a day outside every one of
      // this task's blocks is not its to use, however free it looks.
      const today = a.windows.filter((w) => !w.days || w.days.includes(weekday(day)));
      if (!today.length) { day = cal.next(day + 1); continue; }
      let placedToday = 0;
      const daysLeft = day > lastDay ? 1 : Math.max(1, cal.between(day, lastDay));
      const perDayBlocks = Math.max(1, Math.ceil(Math.ceil(left / size) / daysLeft));
      // Nobody's day is filled wall to wall. The cap is what is left of the
      // day's allowance for the person who has the least of it left, because a
      // block belongs to everyone on the task.
      const capMinutes = Math.round(a.dailyCap * 60);
      const roomToday = Math.min(...people.map((lane) => capMinutes - filledOn(lane, day)));
      if (roomToday < Math.min(size, left)) { day = cal.next(day + 1); continue; }
      let usedToday = 0;
      // Free for everyone on the task: the union of what each of them is doing.
      const busyForAll = people.flatMap((lane) => bookedOn(lane, day));
      const slots = today.flatMap((w) => freeSlots(busyForAll, w.from, w.to)).sort((x, y) => x[0] - y[0]);
      for (const [from, to] of slots) {
        let at = from;
        while (left > 0 && at + Math.min(size, left) <= to && placedToday < perDayBlocks && usedToday + Math.min(size, left) <= roomToday) {
          const minutes = Math.min(size, left);
          const block = {
            taskId: t.id, planId: project.id, planName: project.name,
            day, start: at, end: at + minutes, minutes,
            lanes, lane: lanes[0], people, critical: info.critical, dateIso: fromDay(day), overdue,
          };
          blocks.push(block);
          mine.push(block);
          // What is booked is the time actually used, not the nominal block:
          // half an hour of work in an hour-long block takes half an hour, and
          // reserving the other half leaves a hole nobody asked for. The gap is
          // booked with it, so the next thing — this task's or anyone's —
          // starts after it rather than back to back. Booked for every person
          // on the task, which is what stops the double-booking.
          for (const lane of people) { bookedOn(lane, day).push({ start: at, end: at + minutes + a.gap }); fill(lane, day, minutes); }
          at += minutes + a.gap;
          left -= minutes;
          usedToday += minutes;
          placedToday++;
        }
        if (left <= 0 || placedToday >= perDayBlocks || usedToday + Math.min(size, left) > roomToday) break;
      }
      day = cal.next(day + 1);
    }
    if (left > 0) overflow.push({ taskId: t.id, planId: project.id, minutes: left, reason: 'horizon' });
    byTask.set(t.id, mine);
  }

  // ---- what will be late. The sentence worth saying is "you cannot finish
  // this by Friday": for each task with a deadline, how much of its work lands
  // after it, and the day it would really finish at this rate.
  const late = [];
  for (const { t, project, deadline } of candidates) {
    if (!Number.isFinite(deadline)) continue;
    const mine = byTask.get(t.id) || [];
    let after = 0;
    for (const b of mine) if (b.day > deadline) { b.late = true; after += b.minutes; }
    const unplaced = overflow.filter((o) => o.taskId === t.id && o.planId === project.id).reduce((n, o) => n + o.minutes, 0);
    if (after + unplaced <= 0) continue;
    const finishDay = unplaced > 0 ? null : Math.max(...mine.map((b) => b.day));
    late.push({
      taskId: t.id, planId: project.id, planName: project.name, name: t.name,
      deadline, deadlineIso: fromDay(deadline),
      minutesShort: after + unplaced,
      finishDay, finishIso: finishDay === null ? null : fromDay(finishDay),
    });
  }
  late.sort((a, b) => a.deadline - b.deadline);

  blocks.sort((x, y) => x.day - y.day || x.start - y.start);
  meetings.sort((x, y) => x.day - y.day || x.start - y.start);
  return { blocks, byTask, overflow, meetings, late, droppedPins };
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
    if (!info || info.cyclic || t.archived || isSummary(project, i) || info.percent === 100) return;
    const blockedBy = t.predecessors.filter((l) => !done.has(l.id) && schedule.tasks[l.id]).map((l) => l.id);
    const reasons = [];
    let score = 0;
    const urgency = urgencyOf(t);
    if (urgency !== 'normal') { score += URGENCIES[urgency].weight; reasons.push(URGENCIES[urgency].label.toLowerCase()); }

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
      taskId: t.id, index: info.index, name: t.name, score: Math.round(score), reasons, urgency,
      blocked: blockedBy.length > 0, blockedBy, info,
    });
  });
  return out.sort((a, b) => b.score - a.score || a.info.finish - b.info.finish);
}
