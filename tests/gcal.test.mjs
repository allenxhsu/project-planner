// Planner → Google Calendar export (mcp/gcal.mjs).
//
// The planner's own layout says which hours a task has; the export turns
// that into one Google event per task per day on the plan's calendar, and a
// re-run reconciles against what is there: its own tagged events are updated
// or deleted, hand-made "Planner:" events are adopted, anything else is left
// alone. These tests drive the pure functions and the orchestration with a
// fake Google transport; nothing here talks to Google.
//
// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProject, insertTask, addResource, assign, setTaskField, setPin } from '../src/model/model.js';
import { computeSchedule } from '../src/model/schedule.js';
import {
  HORIZON_DAYS, MIN_MINUTES, TAG_KEY,
  liveEntries, desiredEvents, diffEvents, toGoogleEvent, fromGoogleEvent, describeActions, syncCalendar,
} from '../mcp/gcal.mjs';
import { TOOLS, runTool } from '../mcp/tools.mjs';

const MON = '2026-09-21';
const TUE = '2026-09-22';
/** Monday 07:00, before the working day, so today's hours are all ahead. */
const NOW = new Date(2026, 8, 21, 7, 0);
const CAL = 'abc123@group.calendar.google.com';
const ms = (iso, hhmm) => new Date(`${iso}T${hhmm}:00`).getTime();

/** One person's plan: a 09:00–17:00 day Mon–Fri, two-hour blocks, work as stated. */
function plan(name = 'Alcon', { calendars = true } = {}) {
  const p = createProject(name, MON);
  p.id = `plan_${name.toLowerCase().replace(/\W+/g, '_')}`;
  p.statusDate = MON;
  p.timeBlocks = [{ id: 'tb', name: 'Day', from: '09:00', to: '17:00', days: [1, 2, 3, 4, 5] }];
  p.agenda = { blockHours: 2, timeBlockId: 'tb', gapMinutes: 0, assumedLoad: 100, dailyCap: 0 };
  const ann = addResource(p, { name: 'Ann' });
  return { p, ann, calendars: calendars ? { [name]: CAL } : {} };
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
const desired = (projects, opts = {}) => desiredEvents(entriesOf(...projects), { calendars: { Alcon: CAL }, now: NOW, ...opts });

// ------------------------------------------------------------ desired events

test('a laid task is one event on its plan\'s calendar, titled "task (plan)"', () => {
  const { p, ann } = plan();
  const t = job(p, ann, 'Fixture drawing', { work: 2, notes: 'Rev B, send to Steve' });
  const { events, unmapped } = desired([p]);
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.calendarId, CAL);
  assert.equal(e.dateIso, MON);
  assert.deepEqual([e.start, e.end], [9 * 60, 11 * 60]);
  assert.equal(e.title, 'Fixture drawing (Alcon)');
  assert.equal(e.description.split('\n')[0], 'Planner: Alcon › Fixture drawing');
  assert.match(e.description, /Rev B, send to Steve/);
  assert.equal(e.key, `${p.id}|${t.id}|${MON}|1`);
  assert.deepEqual(unmapped, []);
});

test('a task cut into touching blocks is one event; a gap over 15 minutes makes two', () => {
  const { p, ann } = plan();
  const t = job(p, ann, 'Long job', { work: 4 });
  const { events } = desired([p]);
  const mine = events.filter((e) => e.taskId === t.id && e.dateIso === MON);
  assert.equal(mine.length, 1, 'two two-hour blocks back to back are one event');
  assert.deepEqual([mine[0].start, mine[0].end], [9 * 60, 13 * 60]);

  const { p: q, ann: a2 } = plan();
  const split = job(q, a2, 'Split job', { work: 2 });
  setPin(q, split.id, { day: MON, start: 9 * 60, minutes: 60 });
  setPin(q, split.id, { day: MON, start: 14 * 60, minutes: 60 });
  const two = desired([q]).events.filter((e) => e.taskId === split.id);
  assert.equal(two.length, 2);
  assert.deepEqual(two.map((e) => e.key.split('|')[3]), ['1', '2'], 'each run has its own sequence number');
  assert.deepEqual(two.map((e) => [e.start, e.end]), [[9 * 60, 10 * 60], [14 * 60, 15 * 60]]);
});

test('runs under 15 minutes and the built-in planning routine are skipped', () => {
  const { p, ann } = plan();
  const sliver = job(p, ann, 'Sliver', { work: 0.1 });
  const routine = job(p, ann, 'Plan the next day’s action items', { work: 0.5 });
  routine.builtin = 'plan-tomorrow';
  const real = job(p, ann, 'Real work', { work: 1 });
  const { events } = desired([p]);
  assert.equal(MIN_MINUTES, 15);
  assert.ok(!events.some((e) => e.taskId === sliver.id), 'the sliver is not exported');
  assert.ok(!events.some((e) => e.taskId === routine.id), 'the planning routine is not exported');
  assert.ok(events.some((e) => e.taskId === real.id));
});

test('pins and lateness show as flags in the description', () => {
  const { p, ann } = plan();
  const pinned = job(p, ann, 'Pinned job', { work: 1 });
  setPin(p, pinned.id, { day: TUE, start: 10 * 60, minutes: 60 });
  const late = job(p, ann, 'Late job', { work: 2, deadline: '2026-09-18' });
  const { events } = desired([p]);
  assert.match(events.find((e) => e.taskId === pinned.id).description, /Pinned/);
  assert.match(events.find((e) => e.taskId === late.id).description, /After its deadline/);
});

test('the horizon is 14 days from today; archived plans and plans without a calendar are left out', () => {
  assert.equal(HORIZON_DAYS, 14);
  const { p, ann } = plan();
  job(p, ann, 'Far away', { work: 2 });
  p.tasks[0].constraint = { type: 'SNET', date: '2026-10-19' };   // four weeks out
  job(p, ann, 'Soon', { work: 2 });
  const { events } = desired([p]);
  assert.deepEqual(events.map((e) => e.taskName), ['Soon']);

  const { p: old, ann: a2 } = plan('Old');
  old.archived = true;
  job(old, a2, 'Archived work', { work: 2 });
  assert.equal(liveEntries([{ project: old }, { project: p }]).length, 1, 'archived plans are not laid');

  const { p: other, ann: a3 } = plan('Other');
  job(other, a3, 'Unmapped work', { work: 2 });
  const out = desired([p, other]);
  assert.ok(!out.events.some((e) => e.planName === 'Other'));
  assert.deepEqual(out.unmapped, ['Other']);
});

test('busy events on the primary calendar push unpinned work aside', () => {
  const { p, ann } = plan();
  job(p, ann, 'Morning job', { work: 2 });
  const free = desired([p]).events[0];
  assert.deepEqual([free.start, free.end], [9 * 60, 11 * 60]);
  const busy = [
    { title: 'Smog check', start: ms(MON, '09:00'), end: ms(MON, '10:00'), busy: true },
    { title: 'Hostel stay', start: ms(MON, '00:00'), end: ms(TUE, '00:00'), allDay: true, busy: false },
  ];
  const { events } = desired([p], { busy });
  assert.deepEqual([events[0].start, events[0].end], [10 * 60, 12 * 60], 'laid after the smog check; the free all-day stay books nothing');
});

// ------------------------------------------------------------------- diff

const want = (over = {}) => ({
  key: `plan_alcon|t1|${MON}|1`, calendarId: CAL, planId: 'plan_alcon', taskId: 't1', dateIso: MON,
  start: 9 * 60, end: 11 * 60, title: 'Fixture drawing (Alcon)', description: 'Planner: Alcon › Fixture drawing', ...over,
});
const have = (over = {}) => ({
  id: 'g1', calendarId: CAL, key: `plan_alcon|t1|${MON}|1`, dateIso: MON, start: 9 * 60, end: 11 * 60,
  title: 'Fixture drawing (Alcon)', description: 'Planner: Alcon › Fixture drawing', ...over,
});
const open = () => 'open';
const nowMs = NOW.getTime();

test('diff: nothing there → create; identical → keep; moved → update', () => {
  assert.equal(diffEvents([want()], [], { now: nowMs, taskState: open }).create.length, 1);
  const same = diffEvents([want()], [have()], { now: nowMs, taskState: open });
  assert.equal(same.keep.length, 1);
  assert.equal(same.create.length + same.update.length + same.delete.length, 0);
  const moved = diffEvents([want({ start: 13 * 60, end: 15 * 60 })], [have()], { now: nowMs, taskState: open });
  assert.equal(moved.update.length, 1);
  assert.equal(moved.update[0].existing.id, 'g1');
  assert.equal(moved.update[0].desired.start, 13 * 60);
});

test('diff: a tagged event the layout no longer makes is deleted ahead, left alone once past', () => {
  const ahead = diffEvents([], [have({ dateIso: TUE, start: 9 * 60, end: 11 * 60 })], { now: nowMs, taskState: open });
  assert.deepEqual(ahead.delete.map((e) => e.id), ['g1']);
  const past = diffEvents([], [have({ dateIso: '2026-09-18' })], { now: nowMs, taskState: open });
  assert.equal(past.delete.length, 0);
  assert.equal(past.keep.length, 1);
});

test('diff: a done task\'s event stays with a ✓; a deleted task\'s event goes', () => {
  const done = diffEvents([], [have({ dateIso: TUE })], { now: nowMs, taskState: () => 'done' });
  assert.equal(done.tick.length, 1);
  assert.equal(done.tick[0].title, '✓ Fixture drawing (Alcon)');
  assert.equal(done.delete.length, 0);
  const already = diffEvents([], [have({ dateIso: TUE, title: '✓ Fixture drawing (Alcon)' })], { now: nowMs, taskState: () => 'done' });
  assert.equal(already.tick.length, 0, 'ticked once');
  assert.equal(already.keep.length, 1);
  const gone = diffEvents([], [have({ dateIso: TUE })], { now: nowMs, taskState: () => 'gone' });
  assert.deepEqual(gone.delete.map((e) => e.id), ['g1']);
});

test('diff: an untagged "Planner:" event overlapping a desired one is adopted; foreign events are never touched', () => {
  const hand = have({ id: 'hand', key: null, title: 'Lecture 2/2 (Alcon)', description: 'Planner: Alcon › Lecture 2/2 (done Mon).', start: 9 * 60, end: 10 * 60 });
  const foreign = have({ id: 'f', key: null, title: 'Dentist', description: '', start: 9 * 60, end: 10 * 60 });
  const out = diffEvents([want()], [hand, foreign], { now: nowMs, taskState: open });
  assert.equal(out.adopt.length, 1);
  assert.equal(out.adopt[0].existing.id, 'hand');
  assert.equal(out.adopt[0].desired.key, want().key);
  assert.equal(out.create.length, 0);
  assert.ok(!out.delete.some((e) => e.id === 'f') && !out.update.some((u) => u.existing.id === 'f'), 'the dentist is nobody\'s business');
  // Another day: no overlap, nothing to adopt.
  const elsewhere = diffEvents([want()], [{ ...hand, dateIso: TUE }], { now: nowMs, taskState: open });
  assert.equal(elsewhere.adopt.length, 0);
  assert.equal(elsewhere.create.length, 1);
});

// ------------------------------------------------------- Google event shape

test('to and from a Google event: local clock time in the given zone, the tag in private extended properties', () => {
  const body = toGoogleEvent(want(), 'America/Los_Angeles');
  assert.equal(body.summary, 'Fixture drawing (Alcon)');
  assert.deepEqual(body.start, { dateTime: `${MON}T09:00:00`, timeZone: 'America/Los_Angeles' });
  assert.deepEqual(body.end, { dateTime: `${MON}T11:00:00`, timeZone: 'America/Los_Angeles' });
  assert.equal(body.extendedProperties.private[TAG_KEY], want().key);
  assert.equal(body.transparency, 'opaque');

  const raw = {
    id: 'g9', summary: 'Fixture drawing (Alcon)', description: 'Planner: Alcon › Fixture drawing', status: 'confirmed',
    start: { dateTime: new Date(2026, 8, 21, 9, 0).toISOString() }, end: { dateTime: new Date(2026, 8, 21, 11, 0).toISOString() },
    extendedProperties: { private: { [TAG_KEY]: want().key } },
  };
  const e = fromGoogleEvent(raw, CAL);
  assert.deepEqual({ id: e.id, key: e.key, dateIso: e.dateIso, start: e.start, end: e.end, calendarId: e.calendarId },
    { id: 'g9', key: want().key, dateIso: MON, start: 9 * 60, end: 11 * 60, calendarId: CAL });
  assert.equal(fromGoogleEvent({ ...raw, status: 'cancelled' }, CAL), null, 'cancelled events are not there');
  assert.equal(fromGoogleEvent({ id: 'a', start: { date: MON }, end: { date: TUE } }, CAL).allDay, true);
});

// ---------------------------------------------------------------- the run

/** A Google Calendar that remembers what it was asked. */
function fakeGoogle({ events = {}, primary = [] } = {}) {
  const calls = [];
  return {
    calls,
    timeZone: 'America/Los_Angeles',
    async listEvents(calendarId) { calls.push(['list', calendarId]); return calendarId === 'primary' ? primary : (events[calendarId] || []); },
    async insert(calendarId, body) { calls.push(['insert', calendarId, body]); return { id: `new_${calls.length}`, ...body }; },
    async patch(calendarId, id, body) { calls.push(['patch', calendarId, id, body]); return { id, ...body }; },
    async remove(calendarId, id) { calls.push(['delete', calendarId, id]); },
  };
}
/** A PlannerClient with these plans on its shelf. */
const fakePlanner = (...projects) => ({ async sync() { return {}; }, async plans() { return projects.map((project) => ({ project, record: { id: project.id } })); }, defaultPlanId: null });
const gevent = (over) => ({ id: 'g1', status: 'confirmed', summary: 'x', description: '', start: { dateTime: new Date(2026, 8, 21, 9, 0).toISOString() }, end: { dateTime: new Date(2026, 8, 21, 11, 0).toISOString() }, ...over });

test('a dry run reads every calendar and writes nothing; the text lists what would happen', async () => {
  const { p, ann } = plan();
  job(p, ann, 'Fixture drawing', { work: 2 });
  const gcal = fakeGoogle();
  const out = await syncCalendar({ client: fakePlanner(p), gcal, calendars: { Alcon: CAL }, now: NOW, dryRun: true });
  assert.equal(out.actions.create.length, 1);
  assert.ok(gcal.calls.some(([op, id]) => op === 'list' && id === CAL));
  assert.ok(gcal.calls.some(([op, id]) => op === 'list' && id === 'primary'), 'busy time on the primary calendar is read');
  assert.ok(!gcal.calls.some(([op]) => op !== 'list'), 'nothing is written');
  assert.match(out.text, /create 1/i);
  assert.match(out.text, /Fixture drawing \(Alcon\)/);
  assert.equal(out.applied, false);
});

test('a real run creates, updates, adopts, ticks and deletes on the right calendars', async () => {
  const { p, ann } = plan();
  const draw = job(p, ann, 'Fixture drawing', { work: 2 });       // Mon 09–11: adopted from a hand-made event
  const done = job(p, ann, 'Finished', { work: 2 });
  setTaskField(p, done.id, 'percent', 100);
  const key = (t, iso) => `${p.id}|${t.id}|${iso}|1`;
  const gcal = fakeGoogle({ events: { [CAL]: [
    gevent({ id: 'hand', summary: 'Drawing (Alcon)', description: 'Planner: Alcon › Fixture drawing' }),
    gevent({ id: 'old', summary: 'Finished (Alcon)', description: 'Planner: Alcon › Finished', extendedProperties: { private: { [TAG_KEY]: key(done, TUE) } },
      start: { dateTime: new Date(2026, 8, 22, 9, 0).toISOString() }, end: { dateTime: new Date(2026, 8, 22, 11, 0).toISOString() } }),
    gevent({ id: 'stale', summary: 'Gone (Alcon)', description: 'Planner: Alcon › Gone', extendedProperties: { private: { [TAG_KEY]: `${p.id}|t_gone|${TUE}|1` } },
      start: { dateTime: new Date(2026, 8, 22, 13, 0).toISOString() }, end: { dateTime: new Date(2026, 8, 22, 14, 0).toISOString() } }),
    gevent({ id: 'dentist', summary: 'Dentist' }),
  ] } });
  const out = await syncCalendar({ client: fakePlanner(p), gcal, calendars: { Alcon: CAL }, now: NOW, dryRun: false });
  assert.equal(out.applied, true);
  const writes = gcal.calls.filter(([op]) => op !== 'list');
  const patched = writes.filter(([op]) => op === 'patch').map(([, , id, body]) => [id, body.summary, body.extendedProperties?.private?.[TAG_KEY]]);
  assert.deepEqual(patched.sort(), [
    ['hand', 'Fixture drawing (Alcon)', key(draw, MON)],
    ['old', '✓ Finished (Alcon)', undefined],
  ].sort());
  assert.deepEqual(writes.filter(([op]) => op === 'delete').map(([, cal, id]) => [cal, id]), [[CAL, 'stale']]);
  assert.ok(!writes.some(([op, , id]) => id === 'dentist'), 'the dentist is untouched');
  assert.ok(!writes.some(([op]) => op === 'insert'), 'nothing to create: the drawing was adopted');
});

test('the sync_calendar tool: dry by default, apply on dry_run false, optionally one plan', async () => {
  const tool = TOOLS.find((t) => t.name === 'sync_calendar');
  assert.ok(tool, 'the tool exists');
  assert.equal(tool.inputSchema.properties.dry_run.type, 'boolean');
  const { p, ann } = plan();
  job(p, ann, 'Fixture drawing', { work: 2 });
  const { p: q, ann: a2 } = plan('Zipline');
  job(q, a2, 'Ship it', { work: 1 });
  const client = fakePlanner(p, q);
  client.gcal = fakeGoogle();
  client.calendars = { Alcon: CAL, Zipline: 'zip@group.calendar.google.com' };
  client.now = NOW;

  const dry = await runTool(client, 'sync_calendar', {});
  assert.equal(dry.data.applied, false);
  assert.equal(dry.data.create, 2);
  assert.ok(!client.gcal.calls.some(([op]) => op !== 'list'));

  const one = await runTool(client, 'sync_calendar', { plan: 'Zipline', dry_run: false });
  assert.equal(one.data.applied, true);
  const inserts = client.gcal.calls.filter(([op]) => op === 'insert');
  assert.deepEqual(inserts.map(([, cal]) => cal), ['zip@group.calendar.google.com'], 'only the named plan is written');
  assert.match(one.text, /Ship it \(Zipline\)/);
});

test('describeActions reads like a plan: counts first, then one line per change', () => {
  const text = describeActions({
    create: [want()], update: [], adopt: [], tick: [], delete: [have({ id: 'd', title: 'Old (Alcon)', dateIso: TUE })], keep: [have()],
  }, { unmapped: ['Other'], horizon: [MON, '2026-10-04'] });
  assert.match(text, /create 1/);
  assert.match(text, /delete 1/);
  assert.match(text, /keep 1/);
  assert.match(text, /\+ 2026-09-21 09:00–11:00 Fixture drawing \(Alcon\)/);
  assert.match(text, /- 2026-09-22 09:00–11:00 Old \(Alcon\)/);
  assert.match(text, /no calendar: Other/);
});
