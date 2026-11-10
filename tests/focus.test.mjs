// The daily focus: a day holds at most six tasks — one essential priority,
// two essential and urgent, three maintenance — and the rest wait for the
// next working day with room. The buckets are a pure model (model/focus.js);
// the calendar's placement asks it before laying a task on a day.
//
// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toDay } from '../src/model/calendar.js';
import { createProject, insertTask, addResource, assign, setTaskField, setPin, spawnRoutines } from '../src/model/model.js';
import { computeSchedule } from '../src/model/schedule.js';
import { planBlocksAcross } from '../src/model/agenda.js';
import { DEFAULT_FOCUS, FOCUS_CHOICES, cleanFocus, focusOf, isMaintenanceWork, rankEssential, dayFocus, makeFocus } from '../src/model/focus.js';
import { PLANNING_ROUTINE_ID, ensurePlanningRoutine } from '../src/model/planning.js';
import { serialize, parse } from '../src/io/json.js';
import { dayRows, heldBackFrom } from '../src/model/dayplan.js';

const MON = '2026-09-21';   // a Monday
const TUE = '2026-09-22';
const WED = '2026-09-23';
const THU = '2026-09-24';

// ---- the setting

test('the counts default to 1 / 2 / 3 and are read off the plan', () => {
  assert.deepEqual(DEFAULT_FOCUS, { priority: 1, urgent: 2, maintenance: 3 });
  assert.deepEqual(focusOf(createProject('P')), DEFAULT_FOCUS, 'a plan that says nothing');
  assert.deepEqual(focusOf(null), DEFAULT_FOCUS);
  const p = createProject('P');
  p.agenda = { focus: { priority: 2, urgent: 1, maintenance: 0 } };
  assert.deepEqual(focusOf(p), { priority: 2, urgent: 1, maintenance: 0 }, 'a changed setting');
});

test('a count outside the choices falls back to the default for that bucket', () => {
  assert.deepEqual(FOCUS_CHOICES, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(cleanFocus({ priority: 9, urgent: 'two', maintenance: -1 }), DEFAULT_FOCUS);
  assert.deepEqual(cleanFocus({ priority: '2' }), { priority: 2, urgent: 2, maintenance: 3 }, 'a number as a string is a number');
  assert.deepEqual(cleanFocus('nonsense'), DEFAULT_FOCUS);
});

// ---- ranking

const cand = (key, { urgency = 'normal', deadline = Infinity, critical = false, routine = false, order = 0 } = {}) =>
  ({ planId: 'p', taskId: key, name: key, urgency, deadline, critical, routine, order });

test('essential rank: now, then high, then the earliest deadline, then the critical path, then the scheduler’s order', () => {
  const list = [
    cand('later', { order: 9 }),
    cand('crit', { critical: true, order: 8 }),
    cand('due', { deadline: 50, order: 7 }),
    cand('sooner', { deadline: 40, order: 6 }),
    cand('high', { urgency: 'high', order: 5 }),
    cand('now', { urgency: 'now', deadline: 99, order: 4 }),
    cand('first', { order: 3 }),
  ];
  assert.deepEqual(list.slice().sort(rankEssential).map((c) => c.taskId), ['now', 'high', 'sooner', 'due', 'crit', 'first', 'later']);
});

test('maintenance is a routine, or low urgency; everything else is essential work', () => {
  assert.equal(isMaintenanceWork({ repeatOf: 't_1' }), true, 'an occurrence of a routine');
  assert.equal(isMaintenanceWork({ repeat: { freq: 'daily', from: MON } }), true, 'the routine itself');
  assert.equal(isMaintenanceWork({ urgency: 'low' }), true);
  assert.equal(isMaintenanceWork({ urgency: 'normal' }), false);
  assert.equal(isMaintenanceWork({ urgency: 'high' }), false);
  assert.equal(isMaintenanceWork({}), false);
});

test('a day’s tasks fall into the buckets by rank: one priority, two urgent, the rest maintenance', () => {
  const onDay = [
    cand('a', { order: 1 }), cand('b', { urgency: 'high', order: 2 }), cand('c', { deadline: 10, order: 3 }),
    cand('d', { urgency: 'low', order: 4 }), cand('r', { routine: true, order: 5 }), cand('e', { order: 0 }),
  ];
  const f = dayFocus(onDay, DEFAULT_FOCUS);
  assert.deepEqual(f.priority.map((c) => c.taskId), ['b'], 'high urgency is the one thing the day is for');
  assert.deepEqual(f.urgent.map((c) => c.taskId), ['c', 'e'], 'the deadline, then the scheduler’s order');
  assert.deepEqual(f.maintenance.map((c) => c.taskId), ['r', 'd', 'a'], 'routines first, then low urgency, then whatever remains');
});

test('the buckets follow the setting', () => {
  const onDay = [cand('a', { order: 1 }), cand('b', { order: 2 }), cand('c', { order: 3 })];
  const f = dayFocus(onDay, { priority: 2, urgent: 0, maintenance: 1 });
  assert.deepEqual(f.priority.map((c) => c.taskId), ['a', 'b']);
  assert.deepEqual(f.urgent, []);
  assert.deepEqual(f.maintenance.map((c) => c.taskId), ['c']);
});

// ---- the roster: who gets a day, in the order the calendar asks

test('a day admits at most the six, and says who was held back and where they went', () => {
  const focus = makeFocus(DEFAULT_FOCUS);
  const day = toDay(MON);
  const ok = ['a', 'b', 'c', 'd', 'e', 'f'].map((k, i) => focus.admit(day, cand(k, { order: i })));
  assert.deepEqual(ok, [true, true, true, true, true, true]);
  const seventh = cand('g', { order: 6 });
  assert.equal(focus.admit(day, seventh), false, 'the seventh waits');
  assert.equal(focus.admit(day + 1, seventh), true, 'for the next day');
  const on = focus.on(day);
  assert.equal(on.priority.length + on.urgent.length + on.maintenance.length, 6);
  assert.deepEqual(on.heldBack.map((h) => [h.taskId, h.to]), [['g', day + 1]]);
  assert.deepEqual(focus.on(day + 1).heldBack, []);
  assert.equal(focus.on(day + 5).priority.length, 0, 'an empty day is empty, not an error');
});

test('a task admitted again on the same day — its second block — counts once', () => {
  const focus = makeFocus(DEFAULT_FOCUS);
  const day = toDay(MON);
  const t = cand('t');
  assert.equal(focus.admit(day, t), true);
  assert.equal(focus.admit(day, t), true);
  assert.equal(focus.admit(day, t), true);
  assert.equal(focus.on(day).priority.length + focus.on(day).urgent.length + focus.on(day).maintenance.length, 1);
  for (let i = 0; i < 5; i++) assert.equal(focus.admit(day, cand(`x${i}`, { order: i + 1 })), true, 'five more fit');
  assert.equal(focus.admit(day, cand('x9')), false);
});

test('maintenance work takes only maintenance slots; essential work overflows into what maintenance leaves free', () => {
  const focus = makeFocus(DEFAULT_FOCUS);
  const day = toDay(MON);
  assert.equal(focus.admit(day, cand('r1', { routine: true })), true);
  assert.equal(focus.admit(day, cand('l1', { urgency: 'low' })), true);
  assert.equal(focus.admit(day, cand('l2', { urgency: 'low' })), true);
  assert.equal(focus.admit(day, cand('l3', { urgency: 'low' })), false, 'three maintenance items is the limit');
  assert.equal(focus.admit(day, cand('e1')), true);
  assert.equal(focus.admit(day, cand('e2')), true);
  assert.equal(focus.admit(day, cand('e3')), true);
  assert.equal(focus.admit(day, cand('e4')), false, 'the day is full');
  const on = focus.on(day);
  assert.deepEqual(on.maintenance.map((c) => c.taskId), ['r1', 'l1', 'l2']);

  const spare = makeFocus(DEFAULT_FOCUS);
  for (const k of ['e1', 'e2', 'e3', 'e4', 'e5']) assert.equal(spare.admit(day, cand(k)), true, 'with no maintenance, essential work fills those slots too');
  assert.equal(spare.admit(day, cand('r1', { routine: true })), true, 'one maintenance slot is still free');
  assert.equal(spare.admit(day, cand('e6')), false);
  assert.deepEqual(spare.on(day).maintenance.map((c) => c.taskId), ['r1', 'e4', 'e5'], 'the routine first, then what remained');
});

test('a block fixed by hand is on its day whatever the count', () => {
  const focus = makeFocus(DEFAULT_FOCUS);
  const day = toDay(MON);
  for (let i = 0; i < 6; i++) focus.admit(day, cand(`x${i}`, { order: i }));
  assert.equal(focus.admit(day, cand('pinned'), { force: true }), true);
  const on = focus.on(day);
  assert.equal(on.priority.length + on.urgent.length + on.maintenance.length, 7);
});

test('every count at zero switches the limit off', () => {
  const focus = makeFocus({ priority: 0, urgent: 0, maintenance: 0 });
  assert.equal(focus.off, true);
  const day = toDay(MON);
  for (let i = 0; i < 20; i++) assert.equal(focus.admit(day, cand(`x${i}`, { order: i })), true);
  assert.equal(focus.on(day).heldBack.length, 0);
});

// ---- on the calendar

/** One person's week, from Monday, 09:00–17:00, one-hour blocks, work taken as stated. */
function week() {
  const p = createProject('Week', MON);
  p.statusDate = MON;
  p.timeBlocks = [{ id: 'tb', name: 'Day', from: '09:00', to: '17:00', days: [1, 2, 3, 4, 5] }];
  p.agenda = { blockHours: 1, timeBlockId: 'tb', gapMinutes: 0, assumedLoad: 100, dailyCap: 0 };
  const ann = addResource(p, { name: 'Ann' });
  return { p, ann };
}
function job(p, ann, name, { days = 1, work = 1, deadline = null, urgency = null } = {}) {
  const t = insertTask(p, p.tasks.length, { name, duration: days, level: 1 });
  assign(p, t.id, ann.id, 1);
  setTaskField(p, t.id, 'work', work);
  setTaskField(p, t.id, 'calendarShow', true);
  if (deadline) t.deadline = deadline;
  if (urgency) t.urgency = urgency;
  return t;
}
const lay = (p, opts = {}) => planBlocksAcross([{ project: p, schedule: computeSchedule(p) }], { now: new Date(2026, 8, 21, 0, 0), ...opts });
const tasksOn = (blocks, iso) => [...new Set(blocks.filter((b) => b.dateIso === iso).map((b) => b.taskId))];
const ids = (list) => list.map((c) => c.taskId);

test('a day gets its six and the rest go to the next working day, never dropped', () => {
  const { p, ann } = week();
  // Eight hour-long jobs on a day with eight free hours: all would fit by the hours.
  const jobs = Array.from({ length: 8 }, (_, i) => job(p, ann, `Job ${i + 1}`));
  const out = lay(p);
  assert.equal(tasksOn(out.blocks, MON).length, 6, 'six on Monday');
  assert.deepEqual(tasksOn(out.blocks, TUE), [jobs[6].id, jobs[7].id], 'the other two on Tuesday');
  assert.deepEqual(out.overflow, [], 'nothing is lost');
  const mon = out.focus.on(toDay(MON));
  assert.equal(mon.priority.length, 1);
  assert.equal(mon.urgent.length, 2);
  assert.equal(mon.maintenance.length, 3);
  assert.deepEqual(mon.heldBack.map((h) => [h.taskId, h.to]), [[jobs[6].id, toDay(TUE)], [jobs[7].id, toDay(TUE)]]);
  assert.deepEqual(out.focus.on(toDay(TUE)).heldBack, []);
});

test('the day is held to the ranking: now, then high, then the deadline, then the critical path', () => {
  const { p, ann } = week();
  const plain = job(p, ann, 'Plain');
  const due = job(p, ann, 'Due Thursday', { deadline: THU });
  const high = job(p, ann, 'High', { urgency: 'high' });
  const asap = job(p, ann, 'Now', { urgency: 'now' });
  const mon = lay(p).focus.on(toDay(MON));
  assert.deepEqual(ids(mon.priority), [asap.id]);
  assert.deepEqual(ids(mon.urgent), [high.id, due.id]);
  assert.deepEqual(ids(mon.maintenance), [plain.id], 'what remains is maintenance');
});

test('a routine’s occurrence is maintenance, low urgency after it', () => {
  const { p, ann } = week();
  const low = job(p, ann, 'Tidy', { urgency: 'low' });
  const routine = job(p, ann, 'Weekly report');
  setTaskField(p, routine.id, 'repeat', { freq: 'weekly', days: [1], from: MON });
  const [occurrence] = spawnRoutines(p, MON);
  assign(p, occurrence.id, ann.id, 1);
  const mon = lay(p).focus.on(toDay(MON));
  assert.deepEqual(ids(mon.priority), [], 'nothing essential: the priority slot stays empty rather than being filled with upkeep');
  assert.deepEqual(ids(mon.maintenance), [occurrence.id, low.id]);
});

test('a task cut into several blocks is one of the six', () => {
  const { p, ann } = week();
  const long = job(p, ann, 'Long', { work: 3 });
  const rest = Array.from({ length: 6 }, (_, i) => job(p, ann, `Job ${i + 1}`));
  const out = lay(p);
  assert.equal(out.blocks.filter((b) => b.taskId === long.id && b.dateIso === MON).length, 3, 'three blocks');
  assert.equal(tasksOn(out.blocks, MON).length, 6);
  assert.deepEqual(tasksOn(out.blocks, TUE), [rest[5].id], 'the seventh task waits, not the third block');
});

test('a changed setting changes the day', () => {
  const { p, ann } = week();
  p.agenda.focus = { priority: 1, urgent: 1, maintenance: 1 };
  Array.from({ length: 5 }, (_, i) => job(p, ann, `Job ${i + 1}`));
  const out = lay(p);
  assert.equal(tasksOn(out.blocks, MON).length, 3);
  assert.equal(tasksOn(out.blocks, TUE).length, 2);
  assert.deepEqual(out.focus.counts, { priority: 1, urgent: 1, maintenance: 1 });

  p.agenda.focus = { priority: 0, urgent: 0, maintenance: 0 };
  assert.equal(tasksOn(lay(p).blocks, MON).length, 5, 'off: the hours are filled as before');
});

test('a block fixed by hand keeps its day even when the day is full', () => {
  const { p, ann } = week();
  Array.from({ length: 6 }, (_, i) => job(p, ann, `Job ${i + 1}`));
  const fixed = job(p, ann, 'Dentist');
  setPin(p, fixed.id, { day: MON, start: 16 * 60, minutes: 60 });
  const out = lay(p);
  assert.ok(out.blocks.some((b) => b.taskId === fixed.id && b.dateIso === MON && b.pinned));
  assert.equal(tasksOn(out.blocks, MON).length, 6, 'the fixed block is one of the six');
  assert.equal(tasksOn(out.blocks, TUE).length, 1, 'so one placed job moves on');
});

test('held back is per day: a task refused twice reports the day it finally got', () => {
  const { p, ann } = week();
  // Twelve one-hour jobs: six Monday, six Tuesday; the thirteenth lands Wednesday.
  const jobs = Array.from({ length: 13 }, (_, i) => job(p, ann, `Job ${i + 1}`));
  const out = lay(p);
  assert.deepEqual(tasksOn(out.blocks, WED), [jobs[12].id]);
  const last = out.focus.on(toDay(MON)).heldBack.find((h) => h.taskId === jobs[12].id);
  assert.equal(last.to, toDay(WED));
  assert.equal(out.focus.on(toDay(TUE)).heldBack.find((h) => h.taskId === jobs[12].id).to, toDay(WED));
});

// ---- plans the place is hiding (state/mode.js): at work, a home plan's time is only "Busy"

/** A home plan: the same person, two hours before the working day. */
function homePlan() {
  const { p, ann } = week();
  p.name = 'Home';
  p.timeBlocks = [{ id: 'tb', name: 'Study', from: '06:00', to: '08:00', days: [1, 2, 3, 4, 5] }];
  return { p, ann };
}
const layAcross = (plans, opts = {}) => planBlocksAcross(plans.map((p) => ({ project: p, schedule: computeSchedule(p) })), { now: new Date(2026, 8, 21, 0, 0), ...opts });
const planTasksOn = (blocks, planId, iso) => [...new Set(blocks.filter((b) => b.planId === planId && b.dateIso === iso).map((b) => b.taskId))];

test('a hidden plan’s tasks book their hours but take none of the day’s six', () => {
  const { p, ann } = week();
  const jobs = Array.from({ length: 7 }, (_, i) => job(p, ann, `Job ${i + 1}`));
  const home = homePlan();
  const study = Array.from({ length: 2 }, (_, i) => job(home.p, home.ann, `Study ${i + 1}`));
  const out = layAcross([p, home.p], { hidden: (planId) => planId === home.p.id });
  assert.deepEqual(planTasksOn(out.blocks, home.p.id, MON), study.map((t) => t.id), 'the hidden work is laid where it was: its hours are Busy');
  assert.equal(planTasksOn(out.blocks, p.id, MON).length, 6, 'the shown plan still has its six');
  assert.deepEqual(planTasksOn(out.blocks, p.id, TUE), [jobs[6].id]);
  const mon = out.focus.on(toDay(MON));
  assert.ok([...mon.priority, ...mon.urgent, ...mon.maintenance].every((c) => c.planId === p.id), 'the buckets hold only what is shown');
  assert.deepEqual(mon.heldBack.map((h) => h.taskId), [jobs[6].id], 'and nothing hidden was held back');

  const shown = layAcross([p, home.p]);
  assert.equal(tasksOn(shown.blocks, MON).length, 6, 'at home, the study tasks are among the six like any other');
  assert.ok(study.every((t) => shown.focus.on(toDay(MON)).heldBack.some((h) => h.taskId === t.id)), 'so, laid after the jobs, they wait for Tuesday');
});

test('a hidden plan’s block fixed by hand is not one of the six either', () => {
  const { p, ann } = week();
  Array.from({ length: 6 }, (_, i) => job(p, ann, `Job ${i + 1}`));
  const home = homePlan();
  const workout = job(home.p, home.ann, 'Workout');
  setPin(home.p, workout.id, { day: MON, start: 20 * 60, minutes: 60 });
  const out = layAcross([p, home.p], { hidden: (planId) => planId === home.p.id });
  assert.ok(out.blocks.some((b) => b.taskId === workout.id && b.dateIso === MON && b.pinned), 'the workout is on Monday evening');
  assert.equal(planTasksOn(out.blocks, p.id, MON).length, 6, 'all six jobs stay on Monday');
});

test('a task held back from a day is that day’s business no more: it is laid, and listed, on the day it got', () => {
  const { p, ann } = week();
  const jobs = Array.from({ length: 7 }, (_, i) => job(p, ann, `Job ${i + 1}`));
  const out = lay(p);
  assert.deepEqual(dayRows(out.blocks, toDay(MON)).map((r) => r.task).includes(jobs[6].id), false);
  assert.deepEqual(dayRows(out.blocks, toDay(TUE)).map((r) => r.task), [jobs[6].id]);
  assert.deepEqual(heldBackFrom(out.focus.on(toDay(MON)).heldBack), [{ planId: p.id, taskId: jobs[6].id, to: toDay(TUE) }]);
});

// ---- the built-in routine: plan the next day's action items

test('the planning routine is made once, as a weekday routine with its occurrences, and never twice', () => {
  const { p } = week();
  const made = ensurePlanningRoutine(p, MON);
  assert.ok(made, 'made on first asking');
  const r = p.tasks.find((t) => t.id === PLANNING_ROUTINE_ID);
  assert.equal(r.name, 'Plan the next day’s action items');
  assert.deepEqual(r.repeat, { freq: 'weekdays', from: MON, made: r.repeat.made });
  assert.equal(r.builtin, 'plan-tomorrow');
  assert.equal(r.endOfDay, true);
  assert.equal(+r.work, 0.5, 'half an hour');
  assert.equal(r.calendar.show, false, 'the pattern itself is not on the calendar');
  const occurrences = p.tasks.filter((t) => t.repeatOf === PLANNING_ROUTINE_ID);
  assert.ok(occurrences.length >= 5, 'a fortnight of weekdays made');
  assert.equal(occurrences[0].occurrence, MON);
  assert.equal(occurrences[0].endOfDay, true, 'an occurrence keeps the end-of-day placement');
  assert.equal(ensurePlanningRoutine(p, TUE), null, 'asked again, nothing new');
  assert.equal(p.tasks.filter((t) => t.id === PLANNING_ROUTINE_ID).length, 1);
});

test('its occurrence sits at the end of the working day and is one of the day’s maintenance items', () => {
  const { p, ann } = week();
  ensurePlanningRoutine(p, MON);
  const occurrence = p.tasks.find((t) => t.repeatOf === PLANNING_ROUTINE_ID && t.occurrence === MON);
  assign(p, occurrence.id, ann.id, 1);
  job(p, ann, 'Job');
  const out = lay(p);
  const mine = out.blocks.filter((b) => b.taskId === occurrence.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].dateIso, MON);
  assert.equal(mine[0].start, 16 * 60 + 30, 'the last half hour of 09:00–17:00');
  assert.equal(mine[0].end, 17 * 60);
  const mon = out.focus.on(toDay(MON));
  assert.deepEqual(ids(mon.maintenance), [occurrence.id]);
  assert.equal(ids(mon.priority).length, 1, 'the job is the day’s priority');
});

test('it takes one of the three maintenance slots, so only two other maintenance items are picked', () => {
  const { p, ann } = week();
  ensurePlanningRoutine(p, MON);
  const occurrence = p.tasks.find((t) => t.repeatOf === PLANNING_ROUTINE_ID && t.occurrence === MON);
  assign(p, occurrence.id, ann.id, 1);
  const lows = Array.from({ length: 4 }, (_, i) => job(p, ann, `Low ${i + 1}`, { urgency: 'low' }));
  const mon = lay(p).focus.on(toDay(MON));
  assert.deepEqual(ids(mon.maintenance), [lows[0].id, lows[1].id, occurrence.id], 'two others, and the planning last');
  assert.deepEqual(mon.heldBack.map((h) => h.taskId), [lows[2].id, lows[3].id]);
});

test('essential work does not take the planning slot either', () => {
  const { p, ann } = week();
  ensurePlanningRoutine(p, MON);
  const occurrence = p.tasks.find((t) => t.repeatOf === PLANNING_ROUTINE_ID && t.occurrence === MON);
  assign(p, occurrence.id, ann.id, 1);
  // Six ordinary jobs due Monday, so every one of them sorts before the planning routine.
  const jobs = Array.from({ length: 6 }, (_, i) => job(p, ann, `Job ${i + 1}`, { deadline: MON }));
  const out = lay(p);
  const mon = out.focus.on(toDay(MON));
  assert.equal(ids(mon.priority).length + ids(mon.urgent).length, 3);
  assert.deepEqual(ids(mon.maintenance), [jobs[3].id, jobs[4].id, occurrence.id], 'two jobs overflow into maintenance, the third waits');
  assert.ok(out.blocks.some((b) => b.taskId === occurrence.id && b.dateIso === MON), 'the planning is on Monday');
});

test('ticked off, a planning occurrence is done like any other task and leaves the day', () => {
  const { p, ann } = week();
  ensurePlanningRoutine(p, MON);
  const occurrence = p.tasks.find((t) => t.repeatOf === PLANNING_ROUTINE_ID && t.occurrence === MON);
  assign(p, occurrence.id, ann.id, 1);
  occurrence.percent = 100;
  const out = lay(p);
  assert.equal(out.blocks.filter((b) => b.taskId === occurrence.id).length, 0);
  assert.ok(out.blocks.some((b) => b.taskId === `${PLANNING_ROUTINE_ID}@${TUE}`), 'Tuesday’s is still to come');
});

test('with the limit off, the planning routine is still laid, at the end of the day', () => {
  const { p, ann } = week();
  p.agenda.focus = { priority: 0, urgent: 0, maintenance: 0 };
  ensurePlanningRoutine(p, MON);
  const occurrence = p.tasks.find((t) => t.repeatOf === PLANNING_ROUTINE_ID && t.occurrence === MON);
  assign(p, occurrence.id, ann.id, 1);
  const mine = lay(p).blocks.filter((b) => b.taskId === occurrence.id);
  assert.equal(mine[0]?.start, 16 * 60 + 30);
});

test('the planning routine survives a save: its mark and its place in the day', () => {
  const { p } = week();
  ensurePlanningRoutine(p, MON);
  const back = parse(serialize(p)).project;
  const r = back.tasks.find((t) => t.id === PLANNING_ROUTINE_ID);
  const o = back.tasks.find((t) => t.repeatOf === PLANNING_ROUTINE_ID);
  assert.equal(r.builtin, 'plan-tomorrow');
  assert.equal(o.builtin, 'plan-tomorrow');
  assert.equal(o.endOfDay, true);
  assert.equal(ensurePlanningRoutine(back, MON), null, 'read back, not made again');
});

// ---- a fixed block is the day's sitting

test('a task fixed on a day gets no further blocks of itself that day; the rest moves on', () => {
  // A pinned event (from Google, or by hand) said when the task happens that
  // day. Laying its remaining hours beside the pin drew the task twice on one
  // day, which is what made the calendar read as a wall.
  const { p, ann } = week();
  const long = job(p, ann, 'Long', { work: 4, days: 3 });
  setPin(p, long.id, { day: MON, start: 9 * 60, minutes: 60 });
  const out = lay(p);
  const mine = out.blocks.filter((b) => b.taskId === long.id);
  assert.deepEqual(mine.filter((b) => b.dateIso === MON).map((b) => [b.start, b.minutes, !!b.pinned]), [[9 * 60, 60, true]], 'Monday holds only the pin');
  assert.equal(mine.filter((b) => b.dateIso === TUE).reduce((n, b) => n + b.minutes, 0), 180, 'the other three hours go to Tuesday');
  assert.deepEqual(out.overflow, []);
});

test('a block under way holds its day the same way', () => {
  const { p, ann } = week();
  const long = job(p, ann, 'Long', { work: 3, days: 3 });
  const held = [{ taskId: long.id, planId: p.id, day: toDay(MON), start: 9 * 60, end: 10 * 60 }];
  const out = lay(p, { held, now: new Date(2026, 8, 21, 9, 30) });
  const mine = out.blocks.filter((b) => b.taskId === long.id);
  assert.equal(mine.filter((b) => b.dateIso === MON).length, 1, 'the held block alone');
  assert.equal(mine.filter((b) => b.dateIso === TUE).reduce((n, b) => n + b.minutes, 0), 120);
});
