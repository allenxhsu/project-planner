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
import { isSummary, timeBlocks, getTimeBlock, timeBlockIdsOf, slotsOf, feeds, bufferOf, getResource, identityOf, pinsOf, eventsOf, eventPieces, URGENCIES, urgencyOf } from './model.js';

/** The block sizes a task can be cut into, in hours. */
export const BLOCK_CHOICES = [0.5, 1, 1.5, 2, 4];
/** A plan's defaults, which a task inherits until it says otherwise. */
export const DEFAULT_AGENDA = { blockHours: 1, from: '09:00', to: '17:00', timeBlockId: 'tb_work', gapMinutes: 0, assumedLoad: 100, dailyCap: 0 };
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
/** A day's limit in hours; 0 is none — the schedule's hours are filled, as Motion fills them. */
export const CAP_CHOICES = [0, 2, 4, 6, 8, 12];

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
    // One window per range of each block: a schedule of 9–11:30 and 1–5 on
    // weekdays is two windows a weekday, and the placement walks them in order.
    : list.flatMap((b) => slotsOf(b).map((r) => ({
      from: parseTime(r.from), to: parseTime(r.to), days: [r.day], block: b,
    }))).filter((w) => w.to > w.from).sort((a, b) => a.from - b.from);
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
/** How much work the calendar expects of a task in all: its own figure when it states one. */
export function expectedHours(project, info, task = null) {
  if (info.milestone) return 0;
  const hpd = project.calendar?.hoursPerDay || 8;
  const load = (task ? agendaOf(project, task).assumedLoad : (LOAD_CHOICES.includes(+project.agenda?.assumedLoad) ? +project.agenda.assumedLoad : DEFAULT_AGENDA.assumedLoad)) / 100;
  const stated = task && Number.isFinite(+task.work) && task.work !== null && task.work !== undefined && +task.work >= 0;
  // A task with nobody on it still takes time; the duration is the estimate.
  const full = info.work > 0 ? info.work : info.duration * hpd;
  return stated ? +task.work : full * load;
}

export function hoursLeft(project, info, task = null) {
  if (info.milestone) return 0;
  const expected = expectedHours(project, info, task);
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
/**
 * When a task was put off to ("Do later"), in minutes from day 0, or -Infinity.
 * `calendar.notBefore` is local 'YYYY-MM-DDTHH:MM'.
 */
export function notBeforeOf(t) {
  const s = t.calendar?.notBefore;
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return -Infinity;
  return toDay(s.slice(0, 10)) * 24 * 60 + (+s.slice(11, 13)) * 60 + (+s.slice(14, 16));
}

export function planBlocksAcross(entries, { horizonDays = 180, now = new Date(), held = [], history = [] } = {}) {
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
  // Each task's days are its own: the days its schedule covers, less its own
  // plan's holidays — never the days of whichever plan happens to be listed
  // first (the open one), which put a weekend-only plan's week on every task
  // and took every weekday off the calendar.
  const calendars = new Map();
  const calendarOf = (project) => {
    if (!calendars.has(project)) calendars.set(project, makeCalendar(project.calendar));
    return calendars.get(project);
  };
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
  const todayDay = toDay(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`);
  // Today's hours that have gone are not free: nothing is laid before the
  // next quarter hour. Work that was planned for this morning and not done is
  // laid again from now on, which is what a calendar looked at in the evening
  // should say.
  const nowMinute = Math.min(24 * 60, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15);
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
  // Events made in the planner itself. One with a person takes that person's
  // time; one with nobody takes everyone's — lane '*'. A repeating event is
  // expanded over the days the calendar can show; a free one is drawn and
  // books nothing.
  for (const { project } of entries) for (const ev of eventsOf(project)) {
    const owner = ev.resourceId ? getResource(project, ev.resourceId) : null;
    for (const piece of eventPieces(ev, todayDay - 62, todayDay + horizonDays)) {
      const travel = !ev.allDay && ev.travel > 0;
      meetings.push({
        lane: owner ? personKeyOf(owner) : '*', day: piece.day, start: piece.start, end: piece.end, title: ev.title,
        allDay: !!ev.allDay, location: ev.location || null, description: ev.notes || null, uid: `${ev.id}@${piece.occurrence}`,
        eventId: ev.id, occurrence: piece.occurrence, colour: ev.colour, free: ev.busy === false,
        feedId: null, feedName: 'Made here', planId: project.id, buffer: ev.travel || 0, own: true,
        bufferBefore: travel && piece.first ? Math.min(ev.travel, piece.start) : 0,
        bufferAfter: travel && piece.last ? Math.min(ev.travel, 24 * 60 - piece.end) : 0,
      });
    }
  }
  const bookedOn = (lane, day) => {
    if (!booked.has(lane)) booked.set(lane, new Map());
    const days = booked.get(lane);
    if (!days.has(day)) {
      // Seed the day with whatever the connected calendars already hold,
      // travel time included.
      days.set(day, [
        ...(day === todayDay && nowMinute > 0 ? [{ start: 0, end: nowMinute }] : []),
        ...meetings.filter((m) => !m.free && (m.lane === lane || m.lane === '*') && m.day === day)
          .map((m) => ({ start: m.start - m.bufferBefore, end: m.end + m.bufferAfter }))]);
    }
    return days.get(day);
  };

  const candidates = entries
    .flatMap(({ project, schedule }) => project.tasks
      .map((t, i) => ({ t, i, info: schedule.tasks[t.id], project }))
      // Auto-scheduled work of every stage, as Motion schedules it — a later
      // stage's task waits only on its start date and its predecessors, not
      // on the stage before it being finished — and any task fixed at a time
      // by hand, auto-scheduled or not: its blocks are where they are.
      .filter(({ t, i, info, project: pr }) => info && !info.cyclic && !t.archived && !isSummary(pr, i)
        && (agendaOf(pr, t).show || pinsOf(t).length > 0)))
    .map((c) => ({ ...c, deadline: c.t.deadline ? toDay(c.t.deadline) : Infinity }))
    // Earliest deadline first. For work that can be cut up and done in any
    // order — which is what blocks make of it — on one person's time, that
    // order meets every deadline any order could have met. Urgency breaks ties
    // between equal deadlines, and a task with no deadline sorts after the
    // dated ones, so a plan that sets none lays out exactly as it did.
    //
    // One exception, on purpose: "do it now" still goes first. It is a person
    // saying, in so many words, that this beats the arithmetic.
    //
    // A hard deadline is the other: it is placed before any soft one, so when
    // there is not room for both it is the soft deadline that slips.
    .sort((a, b) =>
      ((urgencyOf(a.t) === 'now' ? 0 : 1) - (urgencyOf(b.t) === 'now' ? 0 : 1))
      || ((a.t.hardDeadline && Number.isFinite(a.deadline) ? 0 : 1) - (b.t.hardDeadline && Number.isFinite(b.deadline) ? 0 : 1))
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
        overdue: info.start < floor, pinned: true, pinIndex: index, ...(pin.live ? { live: true } : {}),
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

  // ---- blocks already under way. A block the calendar laid, that has
  // started and is not done, stays where it is until half an hour after it
  // was due to end — the time to finish it and tick it off — rather than
  // jumping ahead of the clock every quarter hour. After that its work is
  // laid again from now on, and what came after it moves up. The caller says
  // which blocks those are (the layout it drew last).
  for (const h of held) {
    const c = candidates.find((x) => x.t.id === h.taskId && x.project.id === h.planId);
    if (!c || pinsOf(c.t).length || notBeforeOf(c.t) > (h.day * 24 * 60 + h.start)) continue;
    const { t, info, project } = c;
    const left = Math.round(hoursLeft(project, info, t) * 60) - (pinnedMinutes.get(t.id) || 0);
    const minutes = Math.min(h.end - h.start, left);
    if (minutes <= 0) continue;
    const a = agendaOf(project, t);
    const people = peopleOf(project, t);
    const lanes = lanesOf(t);
    const block = {
      taskId: t.id, planId: project.id, planName: project.name,
      day: h.day, start: h.start, end: h.start + minutes, minutes,
      lanes, lane: lanes[0], people, critical: info.critical, dateIso: fromDay(h.day), overdue: false, held: true,
    };
    blocks.push(block);
    if (!byTask.has(t.id)) byTask.set(t.id, []);
    byTask.get(t.id).push(block);
    for (const lane of people) { bookedOn(lane, h.day).push({ start: h.start, end: h.start + minutes + a.gap }); fill(lane, h.day, minutes); }
    pinnedMinutes.set(t.id, (pinnedMinutes.get(t.id) || 0) + minutes);
  }

  // ---- work already done, where it was done. A task that was started and
  // stopped logged its time with the minute it began; the calendar shows it
  // there, ticked, so the day reads as what happened. It is history: it
  // books nothing (the hours behind now are not free anyway) and it counts
  // toward nothing but the task's logged hours.
  // Finished and archived projects (`history`) are not planned, but the time
  // worked on them is still where it was worked.
  const since = -Infinity;   // all of it: the calendar can be scrolled back to any week, and it draws only the days on screen
  for (const { project } of [...entries, ...history]) {
    for (const x of project.timesheets || []) {
      if (!Number.isInteger(x.start) || !x.date || !(x.hours > 0)) continue;
      const day = toDay(x.date);
      if (day < since || day > todayDay + horizonDays) continue;
      const t = project.tasks.find((k) => k.id === x.taskId);
      if (!t) continue;
      const minutes = Math.max(5, Math.round(x.hours * 60));
      const who = x.resourceId && getResource(project, x.resourceId);
      const lane = who ? personKeyOf(who) : '__unassigned';
      blocks.push({
        taskId: t.id, planId: project.id, planName: project.name,
        day, start: x.start, end: Math.min(24 * 60, x.start + minutes), minutes,
        lanes: [lane], lane, people: [lane], critical: false, dateIso: x.date, overdue: false,
        worked: true, sheetId: x.id,
      });
    }
  }

  // ---- then everything else, around them.
  for (const { t, info, project, deadline } of candidates) {
    // A task that is not auto-scheduled keeps only its fixed blocks.
    if (!agendaOf(project, t).show) { if (!byTask.has(t.id)) byTask.set(t.id, []); continue; }
    const a = agendaOf(project, t);
    // The longest window is what decides whether a block can fit at all.
    const windowMinutes = Math.max(0, ...a.windows.map((w) => w.to - w.from));
    let left = Math.round(hoursLeft(project, info, t) * 60) - (pinnedMinutes.get(t.id) || 0);
    // "No chunks": the whole of what is left, in one sitting. A chunk never
    // outgrows the task's schedule or the day's cap, though: a two-hour chunk
    // in a one-hour window is laid as one-hour pieces, not left off the
    // calendar, where nobody would see it — and late, if it is, shows as late.
    const wanted = t.calendar?.whole ? Math.max(15, left) : Math.round(a.blockHours * 60);
    const capMinutes = a.dailyCap ? Math.round(a.dailyCap * 60) : Infinity;
    const size = Math.min(wanted, windowMinutes, capMinutes);
    const mine = byTask.get(t.id) || [];
    if (left <= 0 || size < 15) {
      if (left > 0) overflow.push({ taskId: t.id, planId: project.id, minutes: left, reason: windowMinutes < 15 ? 'window-too-short' : 'none' });
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
    // "Do later": not before the day and minute it was put off to.
    const later = notBeforeOf(t);
    const laterDay = Number.isFinite(later) ? Math.floor(later / (24 * 60)) : -Infinity;
    const laterMinute = Number.isFinite(later) ? later % (24 * 60) : 0;
    const own = calendarOf(project);
    // A window that names its days keeps to them; one that does not (a task's
    // own hours) keeps to its plan's working week.
    const windowsOn = (d) => (own.holidays.has(d) ? [] : a.windows.filter((w) => (w.days ? w.days.includes(weekday(d)) : own.workDays.has(weekday(d)))));
    const nextDay = (d) => { let i = 0; while (!windowsOn(d).length && i++ < 400) d++; return d; };
    const firstDay = nextDay(Math.max(urgency === 'now' ? floor : Math.max(info.start, floor), laterDay));
    const overdue = info.start < floor;
    // As early as there is room, as Motion lays work: every free hour of the
    // task's schedule from its first day on is filled before the next day is
    // used, so today holds all it can hold. (The Gantt still spreads the task
    // over its duration; the calendar is about when it actually gets done.)
    let day = firstDay;
    let guard = 0;
    while (left > 0 && guard++ < horizonDays) {
      // A time block says which days it covers; a day outside every one of
      // this task's blocks is not its to use, however free it looks.
      const today = windowsOn(day);
      if (!today.length) { day = nextDay(day + 1); continue; }
      // A day's limit, when the plan sets one, is what is left of the day's
      // allowance for the person who has the least of it left, because a
      // block belongs to everyone on the task.
      const roomToday = Math.min(...people.map((lane) => capMinutes - filledOn(lane, day)));
      if (roomToday < Math.min(size, left)) { day = nextDay(day + 1); continue; }
      let usedToday = 0;
      // Free for everyone on the task: the union of what each of them is doing.
      const busyForAll = [...people.flatMap((lane) => bookedOn(lane, day)), ...(day === laterDay ? [{ start: 0, end: laterMinute }] : [])];
      const slots = today.flatMap((w) => freeSlots(busyForAll, w.from, w.to)).sort((x, y) => x[0] - y[0]);
      for (const [from, to] of slots) {
        let at = from;
        while (left > 0 && at + Math.min(size, left) <= to && usedToday + Math.min(size, left) <= roomToday) {
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
        }
        if (left <= 0 || usedToday + Math.min(size, left) > roomToday) break;
      }
      day = nextDay(day + 1);
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
    if (urgency !== 'normal') { score += URGENCIES[urgency].weight; reasons.push(urgency === 'now' ? 'ASAP' : `${URGENCIES[urgency].label.toLowerCase()} priority`); }

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
