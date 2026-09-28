// The day's plan: the selection behind both the Today screen and the record
// Flow reads. Pure, so it is tested directly rather than through a render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayRows, agendaRecord, sameDay, caughtUp } from '../src/model/dayplan.js';

const DAY = 10;
const blocks = [
  { day: DAY, planId: 'alcon', taskId: 'call_aris', start: 570, minutes: 60 },
  { day: DAY, planId: 'l3', taskId: 'rotary', start: 630, minutes: 28 },
  { day: DAY, planId: 'l3', taskId: 'rotary', start: 700, minutes: 30 },
  { day: DAY, planId: 'blue', taskId: 'reimburse', start: 675, minutes: 30 },
  { day: DAY + 1, planId: 'ge', taskId: 'tomorrow', start: 60, minutes: 60 },
];

test('only what the calendar laid on that day, earliest first', () => {
  assert.deepEqual(dayRows(blocks, DAY).map((r) => r.task), ['call_aris', 'rotary', 'reimburse']);
  assert.deepEqual(dayRows(blocks, DAY + 1).map((r) => r.task), ['tomorrow']);
  assert.deepEqual(dayRows(blocks, DAY + 5), [], 'a day with nothing laid on it is empty');
});

test('a task laid in pieces is one row: the minutes summed, the earliest start', () => {
  const rotary = dayRows(blocks, DAY).find((r) => r.task === 'rotary');
  assert.equal(rotary.minutes, 58, '28 + 30');
  assert.equal(rotary.start, 630, 'the earlier of its two pieces');
});

test('a finished task belongs under completed, not here', () => {
  const rows = dayRows(blocks, DAY, { percentOf: (p, t) => (t === 'call_aris' ? 100 : 0) });
  assert.deepEqual(rows.map((r) => r.task), ['rotary', 'reimburse']);
});

test('a plan the place is hiding is left out', () => {
  const rows = dayRows(blocks, DAY, { hidden: (p) => p === 'l3' });
  assert.deepEqual(rows.map((r) => r.task), ['call_aris', 'reimburse']);
});

test('two tasks at the same minute keep a stable order between renders', () => {
  const tie = [
    { day: DAY, planId: 'b', taskId: 'x', start: 600, minutes: 30 },
    { day: DAY, planId: 'a', taskId: 'y', start: 600, minutes: 30 },
  ];
  assert.deepEqual(dayRows(tie, DAY).map((r) => r.plan), ['a', 'b']);
  assert.deepEqual(dayRows(tie.slice().reverse(), DAY).map((r) => r.plan), ['a', 'b']);
});

test('the record carries the day, the person and the rows, and nothing else', () => {
  const rec = agendaRecord({ day: '2026-09-28', rows: dayRows(blocks, DAY), person: 'Allen Xu', at: 5, origin: 'mac' });
  assert.equal(rec.id, 'agenda_2026-09-28');
  assert.equal(rec.type, 'agenda');
  assert.equal(rec.person, 'Allen Xu');
  assert.equal(rec.deletedAt, null);
  assert.deepEqual(rec.tasks[0], { plan: 'alcon', task: 'call_aris', start: 570, minutes: 60 });
});

test('a day that says the same thing is not written again', () => {
  // The layout recomputes on every edit; without this the record would be
  // pushed several times a minute and wake every other device each time.
  const rows = dayRows(blocks, DAY);
  const a = agendaRecord({ day: '2026-09-28', rows, person: 'Allen Xu', at: 1, origin: 'mac' });
  const b = agendaRecord({ day: '2026-09-28', rows, person: 'Allen Xu', at: 9999, origin: 'portal' });
  assert.equal(sameDay(a, b), true, 'the time it was computed is not content');

  const moved = dayRows([{ ...blocks[0], start: 600 }, ...blocks.slice(1)], DAY);
  assert.equal(sameDay(a, agendaRecord({ day: '2026-09-28', rows: moved, person: 'Allen Xu' })), false, 'a moved task is');
  assert.equal(sameDay(a, agendaRecord({ day: '2026-09-28', rows, person: 'Someone Else' })), false, 'so is a different person');
});

test('ticking off long-overdue work is catching up, not a day of achievements', () => {
  // Nineteen tasks with deadlines from last year, all ticked at 9:05 this
  // morning, made "Completed today" read as a heroic day. It was housekeeping.
  const today = 1000;
  assert.equal(caughtUp(today - 184, today), true, 'a deadline just over six months ago');
  assert.equal(caughtUp(today - 183, today), false, 'exactly six months is not yet stale');
  assert.equal(caughtUp(today - 10, today), false, 'last week is real work done');
  assert.equal(caughtUp(today + 30, today), false, 'a future deadline certainly is');
});

test('a task with no deadline is never filed as catching up', () => {
  // Nothing says it is old, so nothing may assume it.
  assert.equal(caughtUp(NaN, 1000), false);
  assert.equal(caughtUp(undefined, 1000), false);
  assert.equal(caughtUp(null, 1000), false);
});
