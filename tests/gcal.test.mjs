// Planner ⇄ Google Calendar (mcp/gcal.mjs).
//
// Google Calendar is the source of truth for *when*: an event dragged,
// resized, renamed, ticked or deleted there updates its planner task on the
// next run. The planner owns structure and pushes the laid blocks that have
// no event yet. Both sides carry the other's id — the task's id in the
// event's private extended properties, the event's id in the task's
// `calendar.links` — so renames and moves on either side never break the
// link; hand-made events are linked by proposal, never by guess.
//
// These tests drive the pure functions and the orchestration with a fake
// Google transport and a fake planner client; nothing here talks to Google.
//
// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProject, insertTask, addResource, assign, setTaskField, setPin, pinsOf, linksOf, setLinks } from '../src/model/model.js';
import { serialize, parse } from '../src/io/json.js';
import { computeSchedule } from '../src/model/schedule.js';
import {
  HORIZON_DAYS, LOOKBACK_DAYS, MIN_MINUTES, PROP_PLAN, PROP_TASK,
  calendarMap, liveEntries, parseTitle, matchEvents, desiredEvents, reconcile, applyToPlan,
  toGoogleEvent, fromGoogleEvent, describeActions, syncCalendar,
} from '../mcp/gcal.mjs';
import { TOOLS, runTool } from '../mcp/tools.mjs';

const MON = '2026-09-21';
const TUE = '2026-09-22';
const WED = '2026-09-23';
const LAST_FRI = '2026-09-18';
/** Monday 07:00, before the working day, so today's hours are all ahead. */
const NOW = new Date(2026, 8, 21, 7, 0);
const CAL = 'abc123@group.calendar.google.com';
const ms = (iso, hhmm) => new Date(`${iso}T${hhmm}:00`).getTime();
const iso = (day, hhmm) => new Date(`${day}T${hhmm}:00`).toISOString();

/** One person's plan: a 09:00–17:00 day Mon–Fri, two-hour blocks, work as stated. */
function plan(name = 'Alcon') {
  const p = createProject(name, MON);
  p.id = `plan_${name.toLowerCase().replace(/\W+/g, '_')}`;
  p.statusDate = MON;
  p.timeBlocks = [{ id: 'tb', name: 'Day', from: '09:00', to: '17:00', days: [1, 2, 3, 4, 5] }];
  p.agenda = { blockHours: 2, timeBlockId: 'tb', gapMinutes: 0, assumedLoad: 100, dailyCap: 0 };
  const ann = addResource(p, { name: 'Ann' });
  return { p, ann };
}
function job(p, ann, name, { days = 1, work = 2, notes = '', deadline = null } = {}) {
  const t = insertTask(p, p.tasks.length, { name, duration: days, level: 1 });
  assign(p, t.id, ann.id, 1);
  setTaskField(p, t.id, 'work', work);
  setTaskField(p, t.id, 'calendarShow', true);
  if (notes) t.notes = notes;
  if (deadline) t.deadline = deadline;
  return t;
}
const entriesOf = (...projects) => projects.map((project) => ({ project, schedule: computeSchedule(project) }));
const CALS = { Alcon: CAL };
const desired = (projects, opts = {}) => desiredEvents(entriesOf(...projects), { calendars: CALS, now: NOW, ...opts });

/** A normalised calendar event as fromGoogleEvent returns one. */
function gev({ id = 'g1', calendarId = CAL, day = MON, from = '09:00', to = '11:00', title = 'Fixture drawing (Alcon)', description = 'Planner: Alcon › Fixture drawing', planId = null, taskId = null, updated = ms(MON, '06:00') } = {}) {
  const [sh, sm] = from.split(':').map(Number), [eh, em] = to.split(':').map(Number);
  return { id, calendarId, allDay: false, dateIso: day, start: sh * 60 + sm, end: eh * 60 + em, title, description, planId, taskId,
    startMs: ms(day, from), endMs: ms(day, to), updatedMs: updated, transparent: false, location: '' };
}
/** Link a task to an event and pin it there, as a run that pushed it would have. */
function linked(p, t, ev) {
  setPin(p, t.id, { day: ev.dateIso, start: ev.start, minutes: ev.end - ev.start });
  setLinks(p, t.id, [...linksOf(t), { calendarId: ev.calendarId, eventId: ev.id, day: ev.dateIso, start: ev.start, minutes: ev.end - ev.start, title: ev.title }]);
  return { ...ev, planId: p.id, taskId: t.id };
}

// -------------------------------------------------------------- the model

test('a task keeps its links to calendar events, and they survive save and load', () => {
  const { p, ann } = plan();
  const t = job(p, ann, 'Fixture drawing');
  assert.deepEqual(linksOf(t), []);
  const link = { calendarId: CAL, eventId: 'g1', day: MON, start: 540, minutes: 120, title: 'Fixture drawing (Alcon)' };
  setLinks(p, t.id, [link]);
  assert.deepEqual(linksOf(t), [link]);
  const back = parse(serialize(p)).project;
  assert.deepEqual(linksOf(back.tasks.find((x) => x.id === t.id)), [link]);
  setLinks(p, t.id, [{ calendarId: CAL, eventId: '', day: MON }]);
  assert.deepEqual(linksOf(t), [], 'a link without an event id is no link');
});

test('the committed map: plan name → calendarId, nested or flat', () => {
  const nested = { _note: 'names', plans: { Alcon: { calendarId: CAL, calendarName: 'Claude - Work - Alcon' }, 'ISEN 616': { calendarId: 'isen@g', calendarName: 'ISEN 616 - DOE' } } };
  assert.deepEqual(calendarMap(nested), { Alcon: CAL, 'ISEN 616': 'isen@g' });
  assert.deepEqual(calendarMap({ Alcon: CAL }), { Alcon: CAL });
  assert.deepEqual(calendarMap(null), {});
});

// ------------------------------------------------------------- the titles

test('parseTitle: the task name out of an event title, with ✓ and "(time approx.)" read and dropped', () => {
  const rows = [
    ['Lectures 2/4, 2/6 (ISEN 616)', 'ISEN 616', { name: 'Lectures 2/4, 2/6', done: false, approx: false }],
    ['Lecture 1/30 (ISEN 616) ✓', 'ISEN 616', { name: 'Lecture 1/30', done: true, approx: false }],
    ['✓ Lecture 1/30 (ISEN 616)', 'ISEN 616', { name: 'Lecture 1/30', done: true, approx: false }],
    ['Smog check (time approx.) (Personal tasks)', 'Personal tasks', { name: 'Smog check', done: false, approx: true }],
    ['Call the shop ✓ (time approx.)', 'Personal tasks', { name: 'Call the shop', done: true, approx: true }],
    ['Just a title', 'Alcon', { name: 'Just a title', done: false, approx: false }],
    ['Keep (my) brackets (Alcon)', 'Alcon', { name: 'Keep (my) brackets', done: false, approx: false }],
    ['Black & Decker: Test weather strip', 'Black & Decker - Stanley SO 286652 WO 421950', { name: 'Test weather strip', done: false, approx: false }],
    ['Nest design (AWTE) — priority', 'AWTE - Das Photonics SO 284999 WO 412856', { name: 'Nest design', done: false, approx: false }],
    ['27G final setup, part 1 (Alcon) — priority', 'Alcon', { name: '27G final setup, part 1', done: false, approx: false }],
    ['Gregory: confirm scope', 'Zipline Sales Action Items', { name: 'Gregory: confirm scope', done: false, approx: false }],
  ];
  for (const [title, planName, want] of rows) assert.deepEqual(parseTitle(title, planName), want, title);
});

// ----------------------------------------------------------- the matching

test('matchEvents, table-driven: exact, renamed, moved, split, duplicate titles, orphan', () => {
  const { p, ann } = plan();
  const draw = job(p, ann, 'Fixture drawing', { work: 2 });
  setPin(p, draw.id, { day: MON, start: 9 * 60, minutes: 120 });
  const report = job(p, ann, 'NRE report', { work: 1 });
  setPin(p, report.id, { day: TUE, start: 13 * 60, minutes: 60 });
  const twinA = job(p, ann, 'Call Steve', { work: 1 });
  const twinB = job(p, ann, 'Call Steve', { work: 1 });
  setPin(p, twinA.id, { day: WED, start: 9 * 60, minutes: 60 });
  setPin(p, twinB.id, { day: WED, start: 14 * 60, minutes: 60 });
  const long = job(p, ann, 'Long study', { work: 4 });
  setPin(p, long.id, { day: MON, start: 13 * 60, minutes: 120 });
  setPin(p, long.id, { day: TUE, start: 9 * 60, minutes: 120 });
  const run = (events) => matchEvents(events, { project: p, planName: 'Alcon' });

  const rows = [
    ['exact title on its day', gev({ id: 'e1', title: 'Fixture drawing (Alcon)' }), { taskId: draw.id, how: 'title' }],
    ['renamed on the calendar, most words still the task\'s', gev({ id: 'e2', title: 'Drawing for the fixture (Alcon)', description: '' }), { taskId: draw.id, how: 'words' }],
    ['shortened with the plan as a prefix', gev({ id: 'e2b', day: TUE, from: '13:00', to: '14:00', title: 'Alcon: NRE report, finish', description: '' }), { taskId: report.id, how: 'words' }],
    ['a word or two in common at its pinned slot', gev({ id: 'e2c', title: 'Fixture work block (Alcon)', description: '' }), { taskId: draw.id, how: 'slot' }],
    ['moved to another day, title still matches', gev({ id: 'e3', day: WED, from: '10:00', to: '11:00', title: 'NRE report (Alcon)' }), { taskId: report.id, how: 'title' }],
    ['a split task: a second event on its second day', gev({ id: 'e4', day: TUE, title: 'Long study (Alcon)' }), { taskId: long.id, how: 'title' }],
    ['a ticked hand-made event still matches', gev({ id: 'e5', title: 'Fixture drawing (Alcon) ✓' }), { taskId: draw.id, how: 'title' }],
  ];
  for (const [what, ev, want] of rows) {
    const out = run([ev]);
    assert.equal(out.matches.length, 1, `${what}: matched`);
    assert.equal(out.matches[0].task.id, want.taskId, what);
    assert.equal(out.matches[0].how, want.how, `${what}: how`);
    assert.ok(out.matches[0].score >= 0.6, `${what}: confident`);
  }

  const dup = run([gev({ id: 'e6', day: WED, from: '09:00', to: '10:00', title: 'Call Steve (Alcon)' })]);
  assert.equal(dup.matches.length, 0, 'two tasks of the same name on the same day: nobody is guessed');
  assert.equal(dup.ambiguous.length, 1);
  assert.deepEqual(dup.ambiguous[0].candidates.map((t) => t.id).sort(), [twinA.id, twinB.id].sort());

  const unsure = run([gev({ id: 'e6b', title: 'Deep work (Alcon)', description: '' })]);
  assert.equal(unsure.matches.length, 0, 'a slot alone, with no word in common, is not a match');
  assert.deepEqual(unsure.ambiguous.map((a) => a.candidates.map((t) => t.id)), [[draw.id]], 'the one candidate is listed, not taken');

  const orphan = run([gev({ id: 'e7', from: '15:00', to: '16:00', title: 'Something new (Alcon)', description: '' })]);
  assert.equal(orphan.matches.length + orphan.ambiguous.length, 0);
  assert.deepEqual(orphan.orphans.map((e) => e.id), ['e7']);

  const all = run([gev({ id: 'e1' }), gev({ id: 'e5', title: 'Fixture drawing (Alcon) ✓', day: TUE })]);
  assert.equal(all.matches.length, 2, 'one task may take several events');
});

// -------------------------------------------------------- what to push

test('a laid task is one event on its plan\'s calendar, titled "task (plan)"', () => {
  const { p, ann } = plan();
  const t = job(p, ann, 'Fixture drawing', { work: 2, notes: 'Rev B, send to Steve' });
  const { events, unmapped } = desired([p]);
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.calendarId, CAL);
  assert.deepEqual([e.dateIso, e.start, e.end], [MON, 9 * 60, 11 * 60]);
  assert.equal(e.title, 'Fixture drawing (Alcon)');
  assert.equal(e.description.split('\n')[0], 'Planner: Alcon › Fixture drawing');
  assert.match(e.description, /Rev B, send to Steve/);
  assert.deepEqual([e.planId, e.taskId], [p.id, t.id]);
  assert.deepEqual(unmapped, []);
});

test('touching blocks are one event; a gap over 15 minutes makes two; slivers and the planning routine are skipped', () => {
  const { p, ann } = plan();
  const t = job(p, ann, 'Long job', { work: 4 });
  const one = desired([p]).events.filter((e) => e.taskId === t.id && e.dateIso === MON);
  assert.equal(one.length, 1);
  assert.deepEqual([one[0].start, one[0].end], [9 * 60, 13 * 60]);

  const { p: q, ann: a2 } = plan();
  const split = job(q, a2, 'Split job', { work: 2 });
  setPin(q, split.id, { day: MON, start: 9 * 60, minutes: 60 });
  setPin(q, split.id, { day: MON, start: 14 * 60, minutes: 60 });
  const sliver = job(q, a2, 'Sliver', { work: 0.1 });
  const routine = job(q, a2, 'Plan the next day’s action items', { work: 0.5 });
  routine.builtin = 'plan-tomorrow';
  const { events } = desired([q]);
  assert.equal(MIN_MINUTES, 15);
  assert.deepEqual(events.filter((e) => e.taskId === split.id).map((e) => [e.start, e.end]), [[9 * 60, 10 * 60], [14 * 60, 15 * 60]]);
  assert.ok(!events.some((e) => e.taskId === sliver.id || e.taskId === routine.id));
});

test('pins and lateness are flags; the horizon is 14 days; archived and unmapped plans are left out', () => {
  assert.equal(HORIZON_DAYS, 14);
  const { p, ann } = plan();
  const pinned = job(p, ann, 'Pinned job', { work: 1 });
  setPin(p, pinned.id, { day: TUE, start: 10 * 60, minutes: 60 });
  const late = job(p, ann, 'Late job', { work: 2, deadline: LAST_FRI });
  const far = job(p, ann, 'Far away', { work: 2 });
  far.constraint = { type: 'SNET', date: '2026-10-19' };
  const { events } = desired([p]);
  assert.match(events.find((e) => e.taskId === pinned.id).description, /Pinned/);
  assert.match(events.find((e) => e.taskId === late.id).description, /After its deadline/);
  assert.ok(!events.some((e) => e.taskId === far.id));

  const { p: old, ann: a2 } = plan('Old');
  old.archived = true;
  job(old, a2, 'Archived work');
  assert.equal(liveEntries([{ project: old }, { project: p }]).length, 1);

  const { p: other, ann: a3 } = plan('Other');
  job(other, a3, 'Unmapped work');
  const out = desired([p, other]);
  assert.ok(!out.events.some((e) => e.planName === 'Other'));
  assert.deepEqual(out.unmapped, ['Other']);
});

test('a day that already has the task\'s event is not pushed again; busy time on the primary calendar pushes work aside', () => {
  const { p, ann } = plan();
  const t = job(p, ann, 'Morning job', { days: 2, work: 10 });
  linked(p, t, gev({ id: 'g1', day: MON, from: '09:00', to: '11:00', title: 'Morning job (Alcon)' }));
  const { events } = desired([p]);
  assert.ok(!events.some((e) => e.taskId === t.id && e.dateIso === MON), 'Monday is already on the calendar');
  assert.ok(events.some((e) => e.taskId === t.id && e.dateIso !== MON), 'the remaining hours still go out');

  const { p: q, ann: a2 } = plan();
  job(q, a2, 'Morning job', { work: 2 });
  const busy = [
    { title: 'Smog check', start: ms(MON, '09:00'), end: ms(MON, '10:00'), busy: true },
    { title: 'Hostel stay', start: ms(MON, '00:00'), end: ms(TUE, '00:00'), allDay: true, busy: false },
  ];
  const [e] = desired([q], { busy }).events;
  assert.deepEqual([e.start, e.end], [10 * 60, 12 * 60]);
});

// ---------------------------------------------------------- reconcile

const rec = (projects, existing, opts = {}) => reconcile(entriesOf(...projects), existing, { calendars: CALS, now: NOW, ...opts });

test('reconcile: a linked event untouched on both sides is kept; a new laid block is created', () => {
  const { p, ann } = plan();
  const t = job(p, ann, 'Fixture drawing', { work: 2 });
  const ev = linked(p, t, gev({ id: 'g1' }));
  const other = job(p, ann, 'Other job', { work: 1 });
  const out = rec([p], [ev]);
  assert.equal(out.keep, 1);
  assert.deepEqual(out.pull, []);
  assert.deepEqual(out.create.map((d) => d.taskId), [other.id]);
});

test('reconcile: moved, resized, renamed and ticked on the calendar flow to the task', () => {
  const { p, ann } = plan();
  const t = job(p, ann, 'Fixture drawing', { work: 2 });
  const ev = linked(p, t, gev({ id: 'g1' }));
  const moved = { ...ev, dateIso: TUE, start: 13 * 60, end: 16 * 60, startMs: ms(TUE, '13:00'), endMs: ms(TUE, '16:00'), title: 'Drawing, rev C (Alcon) ✓', updatedMs: ms(MON, '06:30') };
  const out = rec([p], [moved]);
  assert.equal(out.pull.length, 1);
  const [c] = out.pull;
  assert.equal(c.taskId, t.id);
  assert.deepEqual(c.changes.pin, { from: { day: MON, start: 9 * 60, minutes: 120 }, to: { day: TUE, start: 13 * 60, minutes: 180 } });
  assert.deepEqual(c.changes.work, { from: 2, to: 3 }, 'an hour longer on the calendar is an hour more work');
  assert.deepEqual(c.changes.name, { from: 'Fixture drawing', to: 'Drawing, rev C' });
  assert.equal(c.changes.done, true);
  assert.equal(c.conflict, false);
  assert.equal(out.create.length, 0, 'nothing is pushed over it');
});

test('reconcile: a planner-side change alone goes to the calendar; both changed → calendar wins and the planner change is reported', () => {
  const { p, ann } = plan();
  const t = job(p, ann, 'Fixture drawing', { work: 2 });
  const ev = linked(p, t, gev({ id: 'g1' }));
  setTaskField(p, t.id, 'name', 'Fixture drawing, rev B');
  const push = rec([p], [ev]);
  assert.equal(push.update.length, 1);
  assert.equal(push.update[0].existing.id, 'g1');
  assert.equal(push.update[0].desired.title, 'Fixture drawing, rev B (Alcon)');
  assert.equal(push.pull.length, 0);

  const movedToo = { ...ev, start: 14 * 60, end: 16 * 60, startMs: ms(MON, '14:00'), endMs: ms(MON, '16:00') };
  const both = rec([p], [movedToo]);
  assert.equal(both.update.length, 0);
  assert.equal(both.pull.length, 1);
  assert.equal(both.pull[0].conflict, true);
  assert.deepEqual(both.pull[0].changes.pin.to, { day: MON, start: 14 * 60, minutes: 120 });
  assert.match(both.pull[0].plannerChange, /Fixture drawing, rev B/, 'what the planner side had changed is said');
});

test('reconcile: a linked event gone from the calendar unlinks the task; a linked task gone from the plan deletes the event', () => {
  const { p, ann } = plan();
  const t = job(p, ann, 'Fixture drawing', { work: 2 });
  linked(p, t, gev({ id: 'g1' }));
  const gone = rec([p], []);
  assert.deepEqual(gone.unlink.map((u) => [u.taskId, u.link.eventId]), [[t.id, 'g1']]);
  assert.equal(gone.create.length, 0, 'not laid back onto the calendar in the same run');

  const stray = gev({ id: 'g2', day: TUE, planId: p.id, taskId: 't_gone', title: 'Gone (Alcon)' });
  const out = rec([p], [stray]);
  assert.deepEqual(out.delete.map((e) => e.id), ['g2']);
});

test('reconcile: hand-made events are proposed as links, listed when ambiguous, reported as new when nothing fits', () => {
  const { p, ann } = plan();
  const draw = job(p, ann, 'Fixture drawing', { work: 2 });
  setPin(p, draw.id, { day: MON, start: 9 * 60, minutes: 120 });
  job(p, ann, 'Call Steve', { work: 1 });
  job(p, ann, 'Call Steve', { work: 1 });
  const hand = gev({ id: 'hand', title: 'Fixture drawing (Alcon)' });
  const twin = gev({ id: 'twin', day: TUE, title: 'Call Steve (Alcon)', description: '' });
  const fresh = gev({ id: 'fresh', day: WED, title: 'Buy a new vise (Alcon)', description: '' });
  const out = rec([p], [hand, twin, fresh]);
  assert.deepEqual(out.link.map((l) => [l.event.id, l.taskId]), [['hand', draw.id]]);
  assert.deepEqual(out.ambiguous.map((a) => a.event.id), ['twin']);
  assert.deepEqual(out.orphans.map((e) => e.id), ['fresh']);
  assert.ok(!out.create.some((d) => d.taskId === draw.id && d.dateIso === MON), 'a block with a proposed link is not pushed as a second event');
});

// -------------------------------------------------------- apply to a plan

test('applyToPlan writes the calendar\'s changes onto the tasks', () => {
  const { p, ann } = plan();
  const t = job(p, ann, 'Fixture drawing', { work: 2 });
  const ev = linked(p, t, gev({ id: 'g1' }));
  const moved = { ...ev, dateIso: TUE, start: 13 * 60, end: 16 * 60, startMs: ms(TUE, '13:00'), endMs: ms(TUE, '16:00'), title: 'Drawing, rev C (Alcon) ✓' };
  const actions = rec([p], [moved]);
  applyToPlan(p, actions, { now: NOW });
  assert.deepEqual(pinsOf(t), [{ day: TUE, start: 13 * 60, minutes: 180 }]);
  assert.equal(t.work, 3);
  assert.equal(t.name, 'Drawing, rev C');
  assert.equal(t.percent, 100);
  const [link] = linksOf(t);
  assert.deepEqual([link.eventId, link.day, link.start, link.minutes, link.title], ['g1', TUE, 13 * 60, 180, 'Drawing, rev C (Alcon) ✓'], 'the snapshot moves with it');
});

test('applyToPlan: a deleted event clears the pin and link, turns the task off the calendar and says so', () => {
  const { p, ann } = plan();
  const t = job(p, ann, 'Fixture drawing', { work: 2 });
  linked(p, t, gev({ id: 'g1' }));
  applyToPlan(p, rec([p], []), { now: NOW });
  assert.deepEqual(pinsOf(t), []);
  assert.deepEqual(linksOf(t), []);
  assert.equal(t.calendar.show, false);
  assert.match(t.activity.at(-1).text, /deleted on Google Calendar/);
});

test('applyToPlan: proposed links are written only on confirmLinks; orphans become tasks only on adoptNew', () => {
  const { p, ann } = plan();
  const draw = job(p, ann, 'Fixture drawing', { work: 2 });
  setPin(p, draw.id, { day: MON, start: 9 * 60, minutes: 120 });
  const hand = gev({ id: 'hand', title: 'Fixture drawing (Alcon)' });
  const fresh = gev({ id: 'fresh', day: WED, from: '10:00', to: '11:30', title: 'Buy a new vise (Alcon) ✓', description: '' });
  const actions = rec([p], [hand, fresh]);
  const count = p.tasks.length;
  applyToPlan(p, actions, { now: NOW });
  assert.deepEqual(linksOf(draw), []);
  assert.equal(p.tasks.length, count);

  applyToPlan(p, actions, { now: NOW, confirmLinks: true, adoptNew: true });
  assert.deepEqual(linksOf(draw).map((l) => l.eventId), ['hand']);
  const made = p.tasks.find((x) => x.name === 'Buy a new vise');
  assert.ok(made, 'the orphan is a task now');
  assert.deepEqual(pinsOf(made), [{ day: WED, start: 10 * 60, minutes: 90 }]);
  assert.equal(made.work, 1.5);
  assert.equal(made.percent, 100);
  assert.deepEqual(linksOf(made).map((l) => l.eventId), ['fresh']);
});

// ------------------------------------------------------- Google event shape

test('to and from a Google event: local clock time in the zone, plan and task ids in private extended properties', () => {
  const d = { title: 'Fixture drawing (Alcon)', description: 'Planner: Alcon › Fixture drawing', dateIso: MON, start: 9 * 60, end: 11 * 60, planId: 'plan_alcon', taskId: 't1' };
  const body = toGoogleEvent(d, 'America/Los_Angeles');
  assert.deepEqual(body.start, { dateTime: `${MON}T09:00:00`, timeZone: 'America/Los_Angeles' });
  assert.deepEqual(body.end, { dateTime: `${MON}T11:00:00`, timeZone: 'America/Los_Angeles' });
  assert.deepEqual(body.extendedProperties.private, { [PROP_PLAN]: 'plan_alcon', [PROP_TASK]: 't1' });
  assert.equal(body.transparency, 'opaque');

  const raw = {
    id: 'g9', summary: 'Fixture drawing (Alcon)', description: 'Planner: Alcon › Fixture drawing', status: 'confirmed', updated: '2026-09-21T13:30:00Z',
    start: { dateTime: iso(MON, '09:00') }, end: { dateTime: iso(MON, '11:00') },
    extendedProperties: { private: { [PROP_PLAN]: 'plan_alcon', [PROP_TASK]: 't1' } },
  };
  const e = fromGoogleEvent(raw, CAL);
  assert.deepEqual({ id: e.id, planId: e.planId, taskId: e.taskId, dateIso: e.dateIso, start: e.start, end: e.end, calendarId: e.calendarId },
    { id: 'g9', planId: 'plan_alcon', taskId: 't1', dateIso: MON, start: 9 * 60, end: 11 * 60, calendarId: CAL });
  assert.equal(e.updatedMs, Date.parse('2026-09-21T13:30:00Z'));
  assert.equal(fromGoogleEvent({ ...raw, status: 'cancelled' }, CAL), null);
  assert.equal(fromGoogleEvent({ id: 'a', start: { date: MON }, end: { date: TUE } }, CAL).allDay, true);
});

// ---------------------------------------------------------------- the run

function fakeGoogle({ events = {}, primary = [] } = {}) {
  const calls = [];
  return {
    calls, timeZone: 'America/Los_Angeles',
    async listEvents(calendarId) { calls.push(['list', calendarId]); return calendarId === 'primary' ? primary : (events[calendarId] || []); },
    async insert(calendarId, body) { calls.push(['insert', calendarId, body]); return { id: `new_${calls.length}`, ...body }; },
    async patch(calendarId, id, body) { calls.push(['patch', calendarId, id, body]); return { id, ...body }; },
    async remove(calendarId, id) { calls.push(['delete', calendarId, id]); },
  };
}
/** A PlannerClient with these plans on its shelf; edits apply in place. */
function fakePlanner(...projects) {
  return {
    edits: 0, defaultPlanId: null,
    async sync() { return {}; },
    async plans() { return projects.map((project) => ({ project, record: { id: project.id } })); },
    async edit(ref, fn) { const project = projects.find((x) => x.id === ref || x.name === ref); this.edits += 1; const result = fn(project, computeSchedule(project)); return { project, result, pushed: 1 }; },
  };
}
const graw = (over) => ({ id: 'g1', status: 'confirmed', summary: 'x', description: '', updated: '2026-09-21T13:00:00Z', start: { dateTime: iso(MON, '09:00') }, end: { dateTime: iso(MON, '11:00') }, ...over });

test('a dry run reads 14 days back and ahead on every calendar and writes nowhere', async () => {
  assert.equal(LOOKBACK_DAYS, 14);
  const { p, ann } = plan();
  job(p, ann, 'Fixture drawing', { work: 2 });
  const gcal = fakeGoogle();
  const client = fakePlanner(p);
  const out = await syncCalendar({ client, gcal, calendars: CALS, now: NOW, dryRun: true });
  assert.equal(out.actions.create.length, 1);
  assert.ok(gcal.calls.some(([op, id]) => op === 'list' && id === CAL));
  assert.ok(gcal.calls.some(([op, id]) => op === 'list' && id === 'primary'));
  assert.ok(!gcal.calls.some(([op]) => op !== 'list'));
  assert.equal(client.edits, 0);
  assert.match(out.text, /create 1/);
  assert.match(out.text, /Fixture drawing \(Alcon\)/);
  assert.equal(out.applied, false);
});

test('a real run pushes new blocks and records the links, pulls calendar edits, and links hand-made events only when asked', async () => {
  const { p, ann } = plan();
  const draw = job(p, ann, 'Fixture drawing', { work: 2 });           // nothing on the calendar yet → insert + link
  const moved = job(p, ann, 'Moved job', { work: 1 });
  linked(p, moved, gev({ id: 'mv', day: TUE, from: '09:00', to: '10:00', title: 'Moved job (Alcon)' }));
  const hand = job(p, ann, 'Hand job', { work: 1 });
  setPin(p, hand.id, { day: WED, start: 9 * 60, minutes: 60 });
  const gcal = fakeGoogle({ events: { [CAL]: [
    graw({ id: 'mv', summary: 'Moved job (Alcon)', start: { dateTime: iso(TUE, '14:00') }, end: { dateTime: iso(TUE, '15:00') }, extendedProperties: { private: { [PROP_PLAN]: p.id, [PROP_TASK]: moved.id } } }),
    graw({ id: 'hm', summary: 'Hand job (Alcon)', description: 'Planner: Alcon › Hand job', start: { dateTime: iso(WED, '09:00') }, end: { dateTime: iso(WED, '10:00') } }),
    graw({ id: 'dentist', summary: 'Dentist', start: { dateTime: iso(WED, '12:00') }, end: { dateTime: iso(WED, '13:00') } }),
  ] } });
  const client = fakePlanner(p);
  const out = await syncCalendar({ client, gcal, calendars: CALS, now: NOW, dryRun: false });
  assert.equal(out.applied, true);
  const inserts = gcal.calls.filter(([op]) => op === 'insert');
  assert.deepEqual(inserts.map(([, , b]) => [b.summary, b.extendedProperties.private[PROP_TASK]]), [['Fixture drawing (Alcon)', draw.id]]);
  assert.deepEqual(linksOf(draw).map((l) => [l.calendarId, l.day, l.start, l.minutes]), [[CAL, MON, 9 * 60, 120]], 'the task knows its new event');
  assert.ok(linksOf(draw)[0].eventId.startsWith('new_'));
  assert.deepEqual(pinsOf(draw), [{ day: MON, start: 9 * 60, minutes: 120 }], 'and is pinned where the calendar has it');
  assert.deepEqual(pinsOf(moved), [{ day: TUE, start: 14 * 60, minutes: 60 }], 'the calendar\'s move came back');
  assert.deepEqual(linksOf(hand), [], 'the hand-made event is only proposed');
  assert.match(out.text, /link\?.*Hand job/);
  assert.ok(!gcal.calls.some(([op, , id]) => op !== 'list' && id === 'dentist'));
  assert.ok(!gcal.calls.some(([op, , id]) => op === 'patch' && id === 'hm'));

  const again = await syncCalendar({ client, gcal, calendars: CALS, now: NOW, dryRun: false, confirmLinks: true });
  assert.deepEqual(linksOf(hand).map((l) => l.eventId), ['hm']);
  const tagged = gcal.calls.filter(([op, , id]) => op === 'patch' && id === 'hm');
  assert.equal(tagged.length, 1);
  assert.deepEqual(tagged[0][3].extendedProperties.private, { [PROP_PLAN]: p.id, [PROP_TASK]: hand.id }, 'the event learns its task');
  assert.equal(again.applied, true);
});

test('push false: calendar edits still flow in, links are still proposed, but no new events go out', async () => {
  const { p, ann } = plan();
  job(p, ann, 'Fixture drawing', { work: 2 });
  const moved = job(p, ann, 'Moved job', { work: 1 });
  linked(p, moved, gev({ id: 'mv', day: TUE, from: '09:00', to: '10:00', title: 'Moved job (Alcon)' }));
  const gcal = fakeGoogle({ events: { [CAL]: [
    graw({ id: 'mv', summary: 'Moved job (Alcon)', start: { dateTime: iso(TUE, '14:00') }, end: { dateTime: iso(TUE, '15:00') }, extendedProperties: { private: { [PROP_PLAN]: p.id, [PROP_TASK]: moved.id } } }),
  ] } });
  const out = await syncCalendar({ client: fakePlanner(p), gcal, calendars: CALS, now: NOW, dryRun: false, push: false });
  assert.equal(out.actions.create.length, 0);
  assert.equal(out.actions.pull.length, 1);
  assert.ok(!gcal.calls.some(([op]) => op === 'insert'));
  assert.deepEqual(pinsOf(moved), [{ day: TUE, start: 14 * 60, minutes: 60 }]);
});

test('the sync_calendar tool: dry by default, dry_run false applies, plan narrows it, confirm_links and adopt_new opt in', async () => {
  const tool = TOOLS.find((t) => t.name === 'sync_calendar');
  assert.ok(tool);
  for (const k of ['dry_run', 'confirm_links', 'adopt_new', 'push']) assert.equal(tool.inputSchema.properties[k].type, 'boolean', k);
  const { p, ann } = plan();
  job(p, ann, 'Fixture drawing', { work: 2 });
  const { p: q, ann: a2 } = plan('Zipline');
  job(q, a2, 'Ship it', { work: 1 });
  const client = fakePlanner(p, q);
  client.gcal = fakeGoogle({ events: { 'zip@group.calendar.google.com': [graw({ id: 'z1', summary: 'Pack the crate (Zipline)', start: { dateTime: iso(TUE, '09:00') }, end: { dateTime: iso(TUE, '10:00') } })] } });
  client.calendars = { Alcon: CAL, Zipline: 'zip@group.calendar.google.com' };
  client.now = NOW;

  const dry = await runTool(client, 'sync_calendar', {});
  assert.equal(dry.data.applied, false);
  assert.equal(dry.data.create, 2);
  assert.equal(dry.data.orphans, 1);
  assert.ok(!client.gcal.calls.some(([op]) => op !== 'list'));

  const one = await runTool(client, 'sync_calendar', { plan: 'Zipline', dry_run: false, adopt_new: true });
  assert.equal(one.data.applied, true);
  assert.deepEqual(client.gcal.calls.filter(([op]) => op === 'insert').map(([, cal]) => cal), ['zip@group.calendar.google.com']);
  assert.ok(q.tasks.some((t) => t.name === 'Pack the crate'), 'the orphan became a task on adopt_new');
  assert.match(one.text, /Ship it \(Zipline\)/);
});

test('describeActions reads like a plan: counts first, then one line per change', () => {
  const d = { title: 'Fixture drawing (Alcon)', dateIso: MON, start: 9 * 60, end: 11 * 60 };
  const text = describeActions({
    create: [d], update: [], delete: [gev({ id: 'x', title: 'Old (Alcon)', day: TUE })], keep: 1,
    pull: [{ taskName: 'Fixture drawing', planName: 'Alcon', event: gev(), conflict: true, plannerChange: 'name “Fixture drawing, rev B”', changes: { pin: { from: { day: MON, start: 540, minutes: 120 }, to: { day: TUE, start: 780, minutes: 120 } } } }],
    unlink: [{ taskName: 'Lost', planName: 'Alcon', link: { day: WED, start: 540, minutes: 60 } }],
    link: [{ taskName: 'Hand job', planName: 'Alcon', event: gev({ title: 'Hand job (Alcon)' }), score: 1, how: 'title' }],
    ambiguous: [{ event: gev({ id: 'tw', title: 'Call Steve (Alcon)' }), candidates: [{ name: 'Call Steve' }, { name: 'Call Steve' }] }],
    orphans: [gev({ id: 'o', title: 'New thing (Alcon)', day: WED })],
  }, { unmapped: ['Other'], window: [LAST_FRI, '2026-10-04'] });
  assert.match(text, /create 1/);
  assert.match(text, /delete 1/);
  assert.match(text, /pull 1/);
  assert.match(text, /\+ 2026-09-21 09:00–11:00 Fixture drawing \(Alcon\)/);
  assert.match(text, /- 2026-09-22 09:00–11:00 Old \(Alcon\)/);
  assert.match(text, /← .*Fixture drawing.*2026-09-21 09:00 → 2026-09-22 13:00.*conflict.*rev B/);
  assert.match(text, /event deleted: .*Lost/);
  assert.match(text, /link\? .*Hand job/);
  assert.match(text, /ambiguous: .*Call Steve.*2 tasks/);
  assert.match(text, /new on calendar: .*New thing/);
  assert.match(text, /no calendar: Other/);
});
