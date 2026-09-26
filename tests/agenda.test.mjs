// The calendar as a commitment: deadlines first, what will be late, pins,
// travel time, and the week written out as a calendar.
//
// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toDay } from '../src/model/calendar.js';
import {
  createProject, insertTask, addResource, assign, setTaskField, addFeed, setFeedEvents, setFeedField, setPin, pinsOf,
} from '../src/model/model.js';
import { computeSchedule } from '../src/model/schedule.js';
import { planBlocksAcross, formatClock } from '../src/model/agenda.js';
import { writeIcs, blocksToEvents, parseIcs } from '../src/io/ics.js';
import { serialize, parse } from '../src/io/json.js';

const MON = '2026-09-21';   // a Monday
const TUE = '2026-09-22';
const WED = '2026-09-23';
const FRI = '2026-09-25';

/**
 * One person's week, from Monday, 09:00–17:00, blocks of two hours, no gap,
 * work taken as stated. Looked at as of Monday, so nothing depends on the day
 * the tests run.
 */
function week({ cap = 8 } = {}) {
  const p = createProject('Week', MON);
  p.statusDate = MON;
  p.timeBlocks = [{ id: 'tb', name: 'Day', from: '09:00', to: '17:00', days: [1, 2, 3, 4, 5] }];
  p.agenda = { blockHours: 2, timeBlockId: 'tb', gapMinutes: 0, assumedLoad: 100, dailyCap: cap };
  const ann = addResource(p, { name: 'Ann' });
  return { p, ann };
}
function job(p, ann, name, { days = 1, work, deadline = null, urgency = null } = {}) {
  const t = insertTask(p, p.tasks.length, { name, duration: days, level: 1 });
  assign(p, t.id, ann.id, 1);
  setTaskField(p, t.id, 'work', work);
  setTaskField(p, t.id, 'calendarShow', true);
  if (deadline) t.deadline = deadline;
  if (urgency) t.urgency = urgency;
  return t;
}
// The clock is fixed at the start of the Monday, so what "today" is does not
// depend on when the tests run.
const lay = (p, now = new Date(2026, 8, 21, 0, 0)) => planBlocksAcross([{ project: p, schedule: computeSchedule(p) }], { now });
const hoursOn = (blocks, id, iso) => blocks.filter((b) => b.taskId === id && b.dateIso === iso).reduce((n, b) => n + b.minutes, 0) / 60;

test('earliest deadline first meets a deadline that urgency ordering misses', () => {
  const { p, ann } = week();
  // A day's work each, on one person with a day's room. The high-urgency job
  // is due Wednesday; the ordinary one is due today.
  const report = job(p, ann, 'Board report', { work: 8, deadline: WED, urgency: 'high' });
  const quote = job(p, ann, 'Customer quote', { work: 8, deadline: MON });

  const edf = lay(p);
  assert.equal(hoursOn(edf.blocks, quote.id, MON), 8, 'the job due today gets today');
  assert.equal(hoursOn(edf.blocks, report.id, TUE), 8, 'the other still lands before its Wednesday');
  assert.deepEqual(edf.late, [], 'both deadlines met');

  // Ordering by urgency — which is what "do it now" still does, on purpose —
  // puts the report first, and today's quote goes out tomorrow.
  report.urgency = 'now';
  const byUrgency = lay(p);
  assert.equal(hoursOn(byUrgency.blocks, report.id, MON), 8);
  assert.equal(byUrgency.late.length, 1, 'urgency ordering misses one');
  assert.equal(byUrgency.late[0].taskId, quote.id);
  assert.equal(byUrgency.late[0].finishIso, TUE);

  // A plan with no deadlines lays out as it always did: by urgency, then start.
  report.urgency = 'high'; report.deadline = null; quote.deadline = null;
  const plain = lay(p);
  assert.equal(hoursOn(plain.blocks, report.id, MON), 8, 'high urgency first when nothing is dated');
  assert.deepEqual(plain.late, []);
});

test('a task that cannot fit says how many hours are short and when it would really finish', () => {
  const { p, ann } = week({ cap: 4 });
  // Twenty hours due Tuesday, four hours a day: eight fit, twelve do not.
  const t = job(p, ann, 'Wiring loom', { days: 5, work: 20, deadline: TUE });
  const { late, blocks } = lay(p);
  assert.equal(late.length, 1);
  assert.equal(late[0].taskId, t.id);
  assert.equal(late[0].minutesShort / 60, 12, 'twelve hours land after Tuesday');
  assert.equal(late[0].finishIso, FRI, 'and at four a day it finishes on Friday');
  assert.ok(blocks.filter((b) => b.taskId === t.id && b.dateIso > TUE).every((b) => b.late), 'those blocks are marked late');
  assert.ok(blocks.filter((b) => b.taskId === t.id && b.dateIso <= TUE).every((b) => !b.late));
});

test('a pinned block holds its hour while the rest of the week re-lays around it', () => {
  const { p, ann } = week();
  p.agenda = { ...p.agenda, blockHours: 1 };
  const call = job(p, ann, 'Supplier call prep', { work: 4 });
  const other = job(p, ann, 'Drawings', { work: 4 });
  // Dragged to two o'clock on Monday.
  setPin(p, call.id, { day: MON, start: 14 * 60, minutes: 60 });

  const first = lay(p);
  const pinned = first.blocks.filter((b) => b.pinned);
  assert.equal(pinned.length, 1);
  assert.equal(formatClock(pinned[0].start), '2 PM');
  assert.equal(pinned[0].dateIso, MON);
  const callHours = first.blocks.filter((b) => b.taskId === call.id).reduce((n, b) => n + b.minutes, 0) / 60;
  assert.equal(callHours, 4, 'the pin counts toward the work; three more hours are laid');
  const clash = first.blocks.filter((b) => b.dateIso === MON && !b.pinned && b.start < 15 * 60 && b.end > 14 * 60);
  assert.deepEqual(clash, [], 'nothing else is laid into the pinned hour');

  // Log two hours: the computed blocks re-lay, the pin does not move.
  call.percent = 50;
  const second = lay(p);
  const stillPinned = second.blocks.filter((b) => b.pinned);
  assert.equal(stillPinned.length, 1);
  assert.equal(stillPinned[0].start, 14 * 60);
  assert.equal(second.blocks.filter((b) => b.taskId === call.id).reduce((n, b) => n + b.minutes, 0) / 60, 2);
  assert.ok(second.blocks.some((b) => b.taskId === other.id), 'the other task is still laid');

  // A pin survives the file.
  const back = parse(serialize(p)).project;
  assert.deepEqual(pinsOf(back.tasks.find((x) => x.id === call.id)), [{ day: MON, start: 840, minutes: 60 }]);
});

test('a pin that can no longer happen is dropped, not kept as a ghost', () => {
  const { p, ann } = week();
  const t = job(p, ann, 'Site visit', { work: 2 });
  setPin(p, t.id, { day: '2026-09-18', start: 10 * 60, minutes: 60 });   // last Friday
  const past = lay(p);
  assert.equal(past.blocks.filter((b) => b.pinned).length, 0, 'a pin on a day that has gone is not drawn');
  assert.equal(past.droppedPins.length, 1);
  assert.equal(past.droppedPins[0].reason, 'past');
  assert.equal(past.blocks.filter((b) => b.taskId === t.id).reduce((n, b) => n + b.minutes, 0), 120, 'the work is laid instead');

  const done = job(p, ann, 'Finished thing', { work: 2 });
  setPin(p, done.id, { day: TUE, start: 9 * 60, minutes: 60 });
  done.percent = 100;
  const after = lay(p);
  assert.ok(after.droppedPins.some((d) => d.taskId === done.id && d.reason === 'done'));
  assert.ok(!after.blocks.some((b) => b.taskId === done.id));
});

test('an event with a location reserves travel time either side of it', () => {
  const { p, ann } = week();
  p.agenda = { ...p.agenda, blockHours: 0.5 };
  const feed = addFeed(p, { name: 'Personal', url: 'https://example.com/cal.ics', resourceId: ann.id });
  const at = (h, m = 0) => new Date(2026, 8, 21, h, m).getTime();
  setFeedEvents(p, feed.id, [
    { uid: 'dentist', title: 'Dentist', start: at(13), end: at(14), location: '12 Main St' },
    { uid: 'standup', title: 'Stand-up', start: at(9), end: at(9, 30) },
  ]);
  job(p, ann, 'Fill the day', { work: 8 });

  const { blocks, meetings } = lay(p);
  const dentist = meetings.find((m) => m.title === 'Dentist');
  assert.equal(dentist.bufferBefore, 30, 'thirty minutes to get there by default');
  assert.equal(dentist.bufferAfter, 30, 'and thirty back');
  assert.equal(meetings.find((m) => m.title === 'Stand-up').bufferBefore, 0, 'no location, no travel');
  const monday = blocks.filter((b) => b.dateIso === MON);
  assert.deepEqual(monday.filter((b) => b.start < 14.5 * 60 && b.end > 12.5 * 60), [], 'nothing in 12:30–14:30');
  assert.ok(monday.some((b) => b.end === 12.5 * 60), 'work runs right up to the travel time');

  // Per feed, and off by one setting.
  setFeedField(p, feed.id, 'bufferMinutes', 0);
  const off = lay(p);
  assert.equal(off.meetings.find((m) => m.title === 'Dentist').bufferBefore, 0);
  assert.ok(off.blocks.some((b) => b.dateIso === MON && b.end === 13 * 60), 'with it off, work runs to the appointment');

  // The setting and the location travel with the plan.
  setFeedField(p, feed.id, 'bufferMinutes', 45);
  const back = parse(serialize(p)).project;
  assert.equal(back.feeds[0].bufferMinutes, 45);
  assert.equal(back.feeds[0].events.find((e) => e.uid === 'dentist').location, '12 Main St');
});

test('the week written as a calendar reads back the same, with UIDs that hold still', () => {
  const { p, ann } = week();
  const a = job(p, ann, 'Order brackets, gas; panel', { work: 4 });
  job(p, ann, 'Camera spec', { work: 2 });
  const { blocks } = lay(p);
  const describe = (taskId) => {
    const t = p.tasks.find((x) => x.id === taskId);
    return t ? { name: t.name, planName: p.name } : null;
  };
  const events = blocksToEvents(blocks, describe);
  const text = writeIcs(events, { name: 'Week', now: Date.UTC(2026, 8, 21) });
  assert.match(text, /^BEGIN:VCALENDAR\r\n/);
  assert.ok(text.split('\r\n').every((line) => new TextEncoder().encode(line).length <= 75), 'lines are folded');

  const from = new Date(2026, 8, 20).getTime();
  const to = new Date(2026, 8, 28).getTime();
  const read = parseIcs(text, { from, to }).events;
  assert.equal(read.length, blocks.length, 'one event per block');
  const byUid = new Map(read.map((e) => [e.uid, e]));
  for (const e of events) {
    const r = byUid.get(e.uid);
    assert.ok(r, `${e.uid} read back`);
    assert.equal(r.start, e.start);
    assert.equal(r.end, e.end);
    assert.equal(r.title, e.title, 'commas and semicolons survive');
  }

  // Exported again, the UIDs are the same: a calendar re-importing replaces.
  const again = blocksToEvents(lay(p).blocks, describe).map((e) => e.uid);
  assert.deepEqual(again, events.map((e) => e.uid));
  // Monday's two blocks of the order were 9–11 and 11–13. Drag the second to
  // three o'clock: it keeps its UID, so a calendar moves it rather than adding
  // one, and the first — which did not move — keeps its own.
  const uid = (n) => `${a.id}-${MON}-${n}@project-planner`;
  const hourOf = (list, n) => new Date(list.find((e) => e.uid === uid(n)).start).getHours();
  assert.equal(hourOf(events, 1), 9);
  assert.equal(hourOf(events, 2), 11);
  setPin(p, a.id, { day: MON, start: 15 * 60, minutes: 120 });
  const moved = blocksToEvents(lay(p).blocks, describe);
  assert.equal(hourOf(moved, 1), 9, 'the block that stayed keeps its UID and its hour');
  assert.equal(hourOf(moved, 2), 15, 'the block that moved keeps its UID at the new hour');
  assert.equal(moved.filter((e) => e.uid.startsWith(`${a.id}-`)).length, events.filter((e) => e.uid.startsWith(`${a.id}-`)).length, 'nothing added');
  assert.ok(toDay(MON) > 0);
});

test('nothing is laid in hours that have already gone today', () => {
  const { p, ann } = week();
  const t = job(p, ann, 'Report', { days: 1, work: 4 });
  // Monday at 10:05: the day's work starts at 10:15, not at nine.
  const { blocks } = lay(p, new Date(2026, 8, 21, 10, 5));
  const monday = blocks.filter((b) => b.taskId === t.id && b.dateIso === MON);
  assert.ok(monday.length, 'still laid today');
  assert.equal(Math.min(...monday.map((b) => b.start)), 10 * 60 + 15);
  // Late in the evening, today is full and the work goes to tomorrow.
  const evening = lay(p, new Date(2026, 8, 21, 22, 0)).blocks.filter((b) => b.taskId === t.id);
  assert.ok(evening.every((b) => b.dateIso !== MON));
});

test('stopping a started task logs the time where it was worked and re-lays the rest', async () => {
  const { setPin, stopWork, pinsOf } = await import('../src/model/model.js');
  const { p, ann } = week();
  const t = job(p, ann, 'Essay', { days: 1, work: 2 });
  setPin(p, t.id, { day: MON, start: 10 * 60, minutes: 60, live: true });
  assert.equal(pinsOf(t)[0].live, true);
  stopWork(p, t.id, { worked: 15, more: 45 });
  assert.equal(pinsOf(t).length, 0);
  assert.deepEqual(p.timesheets.map((x) => [x.date, x.start, x.hours, x.resourceId]), [[MON, 600, 0.25, ann.id]]);
  // Monday at 10:15: the logged quarter hour is drawn done at 10:00, and the
  // 45 minutes still needed are laid from now, not before.
  const { blocks } = lay(p, new Date(2026, 8, 21, 10, 15));
  const worked = blocks.filter((b) => b.worked);
  assert.deepEqual(worked.map((b) => [b.dateIso, b.start, b.end]), [[MON, 600, 615]]);
  const rest = blocks.filter((b) => b.taskId === t.id && !b.worked);
  assert.equal(rest.reduce((n, b) => n + b.minutes, 0), 45);
  assert.ok(rest.every((b) => b.dateIso !== MON || b.start >= 615));
  // Nothing more needed: done.
  setPin(p, t.id, { day: MON, start: 11 * 60, minutes: 30, live: true });
  stopWork(p, t.id, { worked: 30, more: 0 });
  assert.equal(p.tasks.find((x) => x.id === t.id).percent, 100);
});

test('an event made in the planner is busy time for everyone, and survives a save', async () => {
  const { saveEvent } = await import('../src/model/model.js');
  const { serialize, parse } = await import('../src/io/json.js');
  const { p, ann } = week();
  const t = job(p, ann, 'Draft', { days: 1, work: 2 });
  saveEvent(p, { title: 'Dentist', day: MON, start: 9 * 60, end: 11 * 60 });
  const mine = lay(p).blocks.filter((b) => b.taskId === t.id && b.dateIso === MON);
  assert.ok(mine.length && mine.every((b) => b.start >= 11 * 60), 'the work goes around it');
  assert.deepEqual(parse(serialize(p)).project.events.map((e) => [e.title, e.day, e.start, e.end]), [['Dentist', MON, 540, 660]]);
  assert.throws(() => saveEvent(p, { title: 'Bad', day: MON, start: 600, end: 600 }));
});

test('events repeat, run past midnight, can be free, and keep travel time', async () => {
  const { saveEvent, eventPieces } = await import('../src/model/model.js');
  const { toDay } = await import('../src/model/calendar.js');
  const { p, ann } = week();
  const standup = saveEvent(p, { title: 'Stand-up', day: MON, start: 9 * 60, end: 9 * 60 + 30, repeat: 'weekdays' });
  const days = eventPieces(standup, toDay(MON), toDay(MON) + 13).map((x) => x.day - toDay(MON));
  assert.deepEqual(days, [0, 1, 2, 3, 4, 7, 8, 9, 10, 11]);
  const night = saveEvent(p, { title: 'Flight', day: MON, start: 22 * 60, endDay: TUE, end: 6 * 60 });
  assert.deepEqual(eventPieces(night, toDay(MON), toDay(TUE)).map((x) => [x.day - toDay(MON), x.start, x.end]), [[0, 1320, 1440], [1, 0, 360]]);
  saveEvent(p, { title: 'Maybe', day: MON, start: 10 * 60, end: 12 * 60, busy: false });
  saveEvent(p, { title: 'Offsite', day: MON, start: 13 * 60, end: 14 * 60, travel: 30, location: 'Town' });
  const t = job(p, ann, 'Report', { days: 1, work: 4 });
  const { blocks, meetings } = lay(p);
  const mine = blocks.filter((b) => b.taskId === t.id && b.dateIso === MON);
  // 9:30–12:30 is free (the free event books nothing), 12:30–14:30 is the offsite with travel.
  assert.ok(mine.some((b) => b.start === 9 * 60 + 30), 'work sits in the free event');
  assert.ok(mine.every((b) => b.end <= 12 * 60 + 30 || b.start >= 14 * 60 + 30), 'travel either side is held');
  assert.ok(meetings.some((m) => m.title === 'Maybe' && m.free));
});

test('a hard deadline is placed before a soft one, and "no chunks" lays one block', async () => {
  const { serialize, parse } = await import('../src/io/json.js');
  const { p, ann } = week({ cap: 8 });
  // A day's room Monday. Soft is due Monday, hard is due Tuesday: the hard one goes first.
  const soft = job(p, ann, 'Soft', { days: 1, work: 8, deadline: MON });
  const hard = job(p, ann, 'Hard', { days: 1, work: 8, deadline: TUE });
  setTaskField(p, hard.id, 'hardDeadline', true);
  const { blocks } = lay(p);
  assert.equal(hoursOn(blocks, hard.id, MON), 8);
  assert.equal(hoursOn(blocks, soft.id, MON), 0);
  const one = job(p, ann, 'Essay', { days: 1, work: 3 });
  setTaskField(p, one.id, 'wholeBlock', true);
  setTaskField(p, one.id, 'labels', 'writing, school, writing');
  const mine = lay(p).blocks.filter((b) => b.taskId === one.id);
  assert.deepEqual(mine.map((b) => b.minutes), [180]);
  const back = parse(serialize(p)).project.tasks.find((t) => t.id === one.id);
  assert.deepEqual([back.labels, back.calendar.whole], [['writing', 'school'], true]);
  assert.equal(parse(serialize(p)).project.tasks.find((t) => t.id === hard.id).hardDeadline, true);
});

test('a block under way stays put until half an hour after it ends; after that it is laid again', () => {
  const { p, ann } = week();
  const a = job(p, ann, 'Started', { work: 2 });
  job(p, ann, 'Next', { work: 2 });
  const mon = toDay(MON);
  // At 10:00 the 9–11 block has started. Without being told, the planner lays it from 10:00.
  const at10 = new Date(2026, 8, 21, 10, 0);
  assert.equal(lay(p, at10).blocks.find((b) => b.taskId === a.id).start, 10 * 60);
  // Told it was on the calendar at 9:00, it stays there.
  const held = [{ planId: p.id, taskId: a.id, day: mon, start: 9 * 60, end: 11 * 60 }];
  const kept = planBlocksAcross([{ project: p, schedule: computeSchedule(p) }], { now: at10, held });
  const block = kept.blocks.find((b) => b.taskId === a.id);
  assert.equal(block.start, 9 * 60);
  assert.equal(block.held, true);
  assert.equal(kept.blocks.filter((b) => b.taskId === a.id).reduce((n, b) => n + b.minutes, 0), 120, 'its work is not laid twice');
  // Marked done, it holds nothing.
  setTaskField(p, a.id, 'percent', 100);
  const done = planBlocksAcross([{ project: p, schedule: computeSchedule(p) }], { now: at10, held });
  assert.equal(done.blocks.filter((b) => b.taskId === a.id).length, 0);
});

test('Do later: none of the task is laid before the time it was put off to', () => {
  const { p, ann } = week();
  const t = job(p, ann, 'Later', { work: 2 });
  setTaskField(p, t.id, 'notBefore', `${TUE}T14:00`);
  const first = lay(p).blocks.filter((b) => b.taskId === t.id)[0];
  assert.equal(first.dateIso, TUE);
  assert.ok(first.start >= 14 * 60, `starts at ${formatClock(first.start)}`);
  // It is kept in the file.
  assert.equal(parse(serialize(p)).project.tasks.find((x) => x.id === t.id).calendar.notBefore, `${TUE}T14:00`);
  // Do ASAP clears it.
  setTaskField(p, t.id, 'notBefore', null);
  assert.equal(lay(p).blocks.filter((b) => b.taskId === t.id)[0].dateIso, MON);
});

test('ASAP cuts in front of other projects', () => {
  // Two plans on one person: plan A's task is due first; plan B's is ASAP.
  const a = week(); const b = week();
  b.p.resources[0].personId = 'person_ann'; a.p.resources[0].personId = 'person_ann';
  const early = job(a.p, a.ann, 'Due Tuesday', { work: 8, deadline: TUE });
  const now = job(b.p, b.ann, 'Do it now', { work: 4, urgency: 'now' });
  const both = planBlocksAcross([{ project: a.p, schedule: computeSchedule(a.p) }, { project: b.p, schedule: computeSchedule(b.p) }], { now: new Date(2026, 8, 21, 0, 0) });
  const first = both.blocks.filter((x) => !x.worked).sort((x, y) => x.day - y.day || x.start - y.start)[0];
  assert.equal(first.taskId, now.id, 'the ASAP task is laid first, ahead of the other project');
  assert.equal(first.dateIso, MON);
  assert.ok(both.blocks.some((x) => x.taskId === early.id), 'the other project still gets its time');
});

test('a task fixed at a time shows there even when it is not auto-scheduled', () => {
  const { p, ann } = week();
  const t = job(p, ann, 'Fixed only', { work: 2 });
  setTaskField(p, t.id, 'calendarShow', false);
  setPin(p, t.id, { day: TUE, start: 14 * 60, minutes: 60 });
  const out = lay(p);
  const mine = out.blocks.filter((b) => b.taskId === t.id);
  assert.equal(mine.length, 1, 'only the fixed block — the rest is not laid');
  assert.equal(mine[0].pinned, true);
  assert.equal(mine[0].dateIso, TUE);
});

test('a finished project is not planned, but its logged time is still drawn', () => {
  const live = week();
  const done = week();
  const t = job(done.p, done.ann, 'Old work', { work: 4 });
  done.p.archived = true;
  done.p.timesheets.push({ id: 'ts1', taskId: t.id, resourceId: done.ann.id, date: MON, start: 9 * 60, hours: 1 });
  const out = planBlocksAcross([{ project: live.p, schedule: computeSchedule(live.p) }], { now: new Date(2026, 8, 21, 12, 0), history: [{ project: done.p, schedule: computeSchedule(done.p) }] });
  const mine = out.blocks.filter((b) => b.planId === done.p.id);
  assert.equal(mine.length, 1, 'only the logged hour — nothing of it is laid');
  assert.equal(mine[0].worked, true);
});
